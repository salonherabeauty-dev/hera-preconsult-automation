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
    identityResolution?: string;
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
  return classifications.every((classification) => classification.category === 'EXCLUDED');
}

function unknownTargets(classifications: Array<{ serviceName: string } & ClassificationResult>) {
  return classifications.filter((classification) => classification.category === 'MANUAL_REVIEW');
}

function identityResolution(event: TimelyAppointmentEvent, plan?: ReconciliationPlan): string {
  if (event.source.timelyBookingId && event.source.timelyChangeToken) return 'ICS_UID_AND_CHANGE_TOKEN_VERIFIED';
  if (event.source.timelyBookingId) return 'ICS_UID_VERIFIED';
  if (event.source.timelyChangeToken) return 'CHANGE_TOKEN_VERIFIED';
  if (plan && plan.action !== 'CREATE') return 'DETERMINISTIC_COMPOSITE_MATCH';
  return 'NO_STABLE_IDENTIFIER';
}

function candidateForPlan(
  plan: ReconciliationPlan,
  candidates: ExistingBookingSnapshot[],
): ExistingBookingSnapshot | undefined {
  if ('bookingId' in plan) return candidates.find((candidate) => candidate.id === plan.bookingId);
  if (plan.action === 'NEEDS_REVIEW' && plan.candidates.length === 1) {
    return candidates.find((candidate) => candidate.id === plan.candidates[0]);
  }
  return undefined;
}

function staleNoopPlan(
  plan: ReconciliationPlan,
  candidates: ExistingBookingSnapshot[],
  receivedAt: string,
): ReconciliationPlan {
  const candidate = candidateForPlan(plan, candidates);
  if (!candidate?.lastTimelyEventAt) return plan;
  const incoming = Date.parse(receivedAt);
  const current = Date.parse(candidate.lastTimelyEventAt);
  if (!Number.isFinite(incoming) || !Number.isFinite(current) || incoming >= current) return plan;
  return {
    action: 'NOOP',
    bookingId: candidate.id,
    reason: 'EVENT_OUT_OF_ORDER: older lifecycle email cannot override newer booking state.',
  };
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
    event = parseTimelyEmail({
      subject: message.subject,
      body: message.body,
      gmailMessageId: message.id,
      calendarAttachments: message.calendarAttachments,
    });
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

  const classified = classifyAppointment(event.appointment.services.map((service) => service.serviceName));
  const timing = classifyAppointmentTiming(event.appointment.localIso, now);
  const excluded = allExcluded(classified.classifications);
  const unknown = unknownTargets(classified.classifications);

  if (event.eventType === 'CONFIRMED' && excluded) {
    await repository.finishEvent({
      gmailMessageId: message.id,
      parseStatus: 'ignored',
      identityResolution: identityResolution(event),
    });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Non-target Timely service.' };
  }

  const candidates = await repository.listCandidateBookings(event);

  if (event.eventType === 'CONFIRMED' && timing === 'PAST') {
    await repository.finishEvent({
      gmailMessageId: message.id,
      parseStatus: 'ignored',
      identityResolution: identityResolution(event),
    });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Appointment already passed.' };
  }

  if (unknown.length > 0 && !classified.preconsultRequired) {
    await repository.finishEvent({
      gmailMessageId: message.id,
      parseStatus: 'manual_review',
      identityResolution: identityResolution(event),
    });
    await repository.createAlert({
      severity: 'warning',
      alertType: 'unknown_target_service',
      message: `Target-domain service needs classification review for ${event.customer.name}`,
      context: {
        gmailMessageId: message.id,
        services: unknown.map((classification) => classification.serviceName),
        timelyBookingId: event.source.timelyBookingId,
        timelyChangeToken: event.source.timelyChangeToken,
      },
    });
    return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: 'Unknown target-domain service.' };
  }

  if (unknown.length > 0) {
    await repository.createAlert({
      severity: 'warning',
      alertType: 'unknown_service_in_qualifying_booking',
      message: `Qualifying booking contains an additional service needing policy review for ${event.customer.name}`,
      context: {
        gmailMessageId: message.id,
        services: unknown.map((classification) => classification.serviceName),
      },
    });
  }

  let plan = planReconciliation(event, candidates);

  const hasStableIdentity = Boolean(event.source.timelyBookingId || event.source.timelyChangeToken);
  if (
    event.eventType === 'CHANGED'
    && classified.preconsultRequired
    && timing !== 'PAST'
    && candidates.length === 0
    && plan.action === 'NEEDS_REVIEW'
    && hasStableIdentity
  ) {
    plan = {
      action: 'CREATE',
      reason: 'RECOVERED_FROM_VERIFIED_CHANGED_EVENT: qualifying future change has stable Timely identity and no parent row.',
    };
  }

  if (excluded && plan.action === 'NEEDS_REVIEW' && candidates.length === 0) {
    await repository.finishEvent({
      gmailMessageId: message.id,
      parseStatus: 'ignored',
      identityResolution: identityResolution(event),
    });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Non-target Timely service.' };
  }

  plan = staleNoopPlan(plan, candidates, message.receivedAt);

  if (plan.action === 'NEEDS_REVIEW') {
    const resolution = plan.reason.startsWith('IDENTIFIER_CONFLICT')
      ? 'IDENTIFIER_CONFLICT'
      : identityResolution(event, plan);
    await repository.finishEvent({
      gmailMessageId: message.id,
      parseStatus: 'manual_review',
      identityResolution: resolution,
    });
    await repository.createAlert({
      severity: plan.reason.startsWith('IDENTIFIER_CONFLICT') ? 'critical' : 'warning',
      alertType: excluded ? 'non_target_lifecycle_reconciliation_review' : 'booking_reconciliation_review',
      message: `Timely ${event.eventType.toLowerCase()} event could not be matched deterministically.`,
      context: {
        gmailMessageId: message.id,
        reason: plan.reason,
        candidates: plan.candidates,
        timelyBookingId: event.source.timelyBookingId,
        timelyChangeToken: event.source.timelyChangeToken,
      },
    });
    return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: plan.reason };
  }

  let applied: { bookingId?: string; outcome: string };
  try {
    applied = await repository.applyPlan({
      message,
      event,
      plan,
      classifications: classified.classifications,
      timing,
    });
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    if (errorText.startsWith('IDENTIFIER_CONFLICT')) {
      await repository.finishEvent({
        gmailMessageId: message.id,
        parseStatus: 'manual_review',
        error: errorText,
        identityResolution: 'IDENTIFIER_CONFLICT',
      });
      await repository.createAlert({
        severity: 'critical',
        alertType: 'identifier_conflict',
        message: `Stable Timely identity conflict for ${event.customer.name}`,
        context: { gmailMessageId: message.id, error: errorText },
      });
      return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: errorText };
    }
    throw error;
  }

  await repository.finishEvent({
    gmailMessageId: message.id,
    bookingId: applied.bookingId,
    parseStatus: 'parsed',
    identityResolution: plan.reason.startsWith('EVENT_OUT_OF_ORDER')
      ? 'EVENT_OUT_OF_ORDER'
      : identityResolution(event, plan),
  });

  if (classified.preconsultRequired && timing === 'SAME_DAY_URGENT' && event.eventType !== 'CANCELLED') {
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
