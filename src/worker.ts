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
  const candidates = await repository.listCandidateBookings(event);

  if (event.eventType === 'CONFIRMED' && allExcluded(classified.classifications)) {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'ignored' });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Non-target Timely service.' };
  }

  if (event.eventType === 'CONFIRMED' && timing === 'PAST') {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'ignored' });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Appointment already passed.' };
  }

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

  const plan = planReconciliation(event, candidates);
  if (plan.action === 'NEEDS_REVIEW') {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'manual_review' });
    await repository.createAlert({
      severity: 'warning',
      alertType: 'booking_reconciliation_review',
      message: `Timely ${event.eventType.toLowerCase()} event could not be matched deterministically.`,
      context: { gmailMessageId: message.id, reason: plan.reason, candidates: plan.candidates },
    });
    return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: plan.reason };
  }

  if ((event.eventType === 'CHANGED' || event.eventType === 'CANCELLED') && candidates.length === 0 && allExcluded(classified.classifications)) {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'ignored' });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Non-target lifecycle event with no tracked booking.' };
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

  if (timing === 'SAME_DAY_URGENT' && event.eventType !== 'CANCELLED') {
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
