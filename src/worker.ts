import { classifyAppointment } from './serviceRules.js';
import { classifyAppointmentTiming, type AppointmentTiming } from './syncPolicy.js';
import { parseTimelyEmail } from './timelyParser.js';
import { planReconciliation, type ExistingBookingSnapshot, type ReconciliationPlan } from './reconcile.js';
import type { ClassificationResult, TimelyAppointmentEvent } from './types.js';
import type { GmailLifecycleMessage } from './gmailApi.js';

export interface StoredEventState {
  exists: boolean;
  processed: boolean;
}

export interface WorkerRepository {
  getEventState(gmailMessageId: string): Promise<StoredEventState>;
  startEvent(input: {
    message: GmailLifecycleMessage;
    event?: TimelyAppointmentEvent;
    parseStatus: 'processing' | 'error';
    error?: string;
  }): Promise<void>;
  listCandidateBookings(event: TimelyAppointmentEvent): Promise<ExistingBookingSnapshot[]>;
  applyPlan(input: {
    message: GmailLifecycleMessage;
    event: TimelyAppointmentEvent;
    plan: ReconciliationPlan;
    classifications: Array<{ serviceName: string } & ClassificationResult>;
    timing: AppointmentTiming;
  }): Promise<{ bookingId?: string; outcome: string }>;
  finishEvent(input: {
    gmailMessageId: string;
    bookingId?: string;
    parseStatus: 'parsed' | 'ignored' | 'manual_review' | 'error';
    error?: string;
  }): Promise<void>;
  createAlert(input: {
    severity: 'info' | 'warning' | 'error' | 'critical';
    alertType: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<void>;
}

export interface ProcessMessageResult {
  gmailMessageId: string;
  status: 'PROCESSED' | 'IGNORED' | 'MANUAL_REVIEW' | 'DUPLICATE' | 'ERROR';
  outcome: string;
  bookingId?: string;
}

function allExcluded(classifications: Array<{ serviceName: string } & ClassificationResult>): boolean {
  return classifications.every((c) => c.category === 'EXCLUDED');
}

function hasUnknownTarget(classifications: Array<{ serviceName: string } & ClassificationResult>): boolean {
  return classifications.some((c) => c.category === 'MANUAL_REVIEW');
}

export async function processLifecycleMessage(
  message: GmailLifecycleMessage,
  repository: WorkerRepository,
  now = new Date(),
): Promise<ProcessMessageResult> {
  const state = await repository.getEventState(message.id);
  if (state.exists && state.processed) {
    return { gmailMessageId: message.id, status: 'DUPLICATE', outcome: 'Gmail message already processed.' };
  }

  let event: TimelyAppointmentEvent;
  try {
    event = parseTimelyEmail({ subject: message.subject, body: message.body, gmailMessageId: message.id });
    await repository.startEvent({ message, event, parseStatus: 'processing' });
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    await repository.startEvent({ message, parseStatus: 'error', error: errorText });
    await repository.createAlert({
      severity: 'error',
      alertType: 'timely_parse_error',
      message: `Could not parse Timely Gmail message ${message.id}`,
      context: { subject: message.subject, error: errorText },
    });
    return { gmailMessageId: message.id, status: 'ERROR', outcome: errorText };
  }

  const classified = classifyAppointment(event.appointment.services.map((s) => s.serviceName));
  const timing = classifyAppointmentTiming(event.appointment.localIso, now);

  const excluded = allExcluded(classified.classifications);

  // Non-target confirmations never enter storage. CHANGED/CANCELLED events are
  // different: they may be the lifecycle continuation of a booking that used
  // to be qualifying, so we inspect tracked candidates before deciding to ignore.
  if (event.eventType === 'CONFIRMED' && excluded) {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'ignored' });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Non-target Timely service.' };
  }

  const candidates = await repository.listCandidateBookings(event);

  if (event.eventType === 'CONFIRMED' && timing === 'PAST') {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'ignored' });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Appointment already passed.' };
  }

  // Unknown target-domain services fail closed to manual review. Fully excluded
  // lifecycle events are handled below: untracked ones are ignored, while tracked
  // scope transitions are reconciled so stale qualifying rows cannot survive.
  if (hasUnknownTarget(classified.classifications)) {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'manual_review' });
    await repository.createAlert({
      severity: 'warning',
      alertType: 'unknown_target_service',
      message: `Target-domain service needs classification review for ${event.customer.name}`,
      context: {
        gmailMessageId: message.id,
        services: classified.classifications.map((c) => c.serviceName),
      },
    });
    return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: 'Unknown target-domain service.' };
  }

  let plan = planReconciliation(event, candidates);

  // A qualifying CHANGED notification with no tracked candidate means the
  // appointment has just entered Hera's pre-consult scope (for example haircut
  // -> balayage). Creating it is safe because there is no candidate for that
  // customer/booking reference and Gmail message-id dedupe remains in force.
  if (
    event.eventType === 'CHANGED'
    && !excluded
    && timing !== 'PAST'
    && candidates.length === 0
    && plan.action === 'NEEDS_REVIEW'
  ) {
    plan = { action: 'CREATE', reason: 'Changed appointment entered qualifying pre-consult scope with no tracked booking.' };
  }

  // If a non-target CHANGED/CANCELLED event has no tracked booking, it is simply
  // outside scope (children's haircuts, blow-dries, extensions, etc.). If it does
  // match a tracked booking, apply the lifecycle transition so stale qualifying
  // rows disappear from the queue. Ambiguity is surfaced instead of guessed.
  if (excluded && plan.action === 'NEEDS_REVIEW' && candidates.length === 0) {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'ignored' });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Non-target Timely service.' };
  }

  if (plan.action === 'NEEDS_REVIEW') {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'manual_review' });
    await repository.createAlert({
      severity: 'warning',
      alertType: excluded ? 'non_target_lifecycle_reconciliation_review' : 'booking_reconciliation_review',
      message: `Timely ${event.eventType.toLowerCase()} event could not be matched deterministically.`,
      context: { gmailMessageId: message.id, reason: plan.reason, candidates: plan.candidates },
    });
    return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: plan.reason };
  }

  const applied = await repository.applyPlan({
    message,
    event,
    plan,
    classifications: classified.classifications,
    timing,
  });
  await repository.finishEvent({
    gmailMessageId: message.id,
    bookingId: applied.bookingId,
    parseStatus: 'parsed',
  });

  if (!excluded && timing === 'SAME_DAY_URGENT' && event.eventType !== 'CANCELLED') {
    await repository.createAlert({
      severity: 'info',
      alertType: 'same_day_booking',
      message: `Same-day qualifying appointment detected for ${event.customer.name}.`,
      context: { gmailMessageId: message.id, bookingId: applied.bookingId },
    });
  }

  return {
    gmailMessageId: message.id,
    status: 'PROCESSED',
    outcome: applied.outcome,
    bookingId: applied.bookingId,
  };
}
