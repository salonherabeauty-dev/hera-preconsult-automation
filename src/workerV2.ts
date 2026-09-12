import { parseTimelyEmail } from './timelyParser.js';
import { classifyAppointmentTiming } from './syncPolicy.js';
import { classifyAppointmentV2 } from './serviceRulesV2.js';
import { planReconciliationV2, identityCompatible, type VerifiedBookingSnapshot } from './reconcileV2.js';
import type { WorkerRepository, ProcessMessageResult } from './worker.js';
import type { TimelyAppointmentEvent, ServiceRule } from './types.js';
import type { GmailLifecycleMessage } from './gmailApi.js';
import type { ReconciliationPlan } from './reconcile.js';

interface RecoveryRepository extends WorkerRepository {
  getServiceRules?(): Promise<ServiceRule[]>;
  holdCancellationForReview?(event: TimelyAppointmentEvent, messageId: string): Promise<void>;
}
function resolution(e: TimelyAppointmentEvent): string {
  return e.source.timelyBookingId ? (e.source.timelyChangeToken ? 'ICS_UID_AND_CHANGE_TOKEN_VERIFIED' : 'ICS_UID_VERIFIED') : (e.source.timelyChangeToken ? 'CHANGE_TOKEN_VERIFIED' : 'NO_STABLE_IDENTIFIER');
}
export async function processLifecycleMessageV2(message: GmailLifecycleMessage, repository: RecoveryRepository, now = new Date()): Promise<ProcessMessageResult> {
  const state = await repository.getEventState(message.id);
  if (state.exists && state.processed) return { gmailMessageId: message.id, status: 'DUPLICATE', outcome: 'Verified completed event already exists.' };
  let event: TimelyAppointmentEvent;
  try {
    event = parseTimelyEmail({ subject: message.subject, body: message.body, gmailMessageId: message.id, calendarAttachments: message.calendarAttachments });
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    await repository.startEvent({ message, parseStatus: 'error', error: errorText });
    await repository.createAlert({ severity: 'error', alertType: 'timely_parse_error', message: `Could not parse Timely message ${message.id}`, context: { gmailMessageId: message.id, error: errorText } });
    return { gmailMessageId: message.id, status: 'ERROR', outcome: errorText };
  }
  await repository.startEvent({ message, event, parseStatus: 'processing' });
  const classified = classifyAppointmentV2(event.appointment.services.map((s) => s.serviceName), await repository.getServiceRules?.());
  const unknown = classified.classifications.filter((c) => c.category === 'MANUAL_REVIEW');
  const excluded = classified.classifications.every((c) => c.category === 'EXCLUDED');
  const timing = classifyAppointmentTiming(event.appointment.localIso, now);
  const candidates = await repository.listCandidateBookings(event) as VerifiedBookingSnapshot[];
  let plan: ReconciliationPlan = planReconciliationV2(event, candidates);
  const targetId = 'bookingId' in plan ? plan.bookingId : plan.action === 'NEEDS_REVIEW' && plan.candidates.length === 1 ? plan.candidates[0] : undefined;
  const candidate = candidates.find((b) => b.id === targetId);
  if (candidate?.lastTimelyEventAt && Date.parse(message.receivedAt) < Date.parse(candidate.lastTimelyEventAt)) {
    plan = { action: 'NOOP', bookingId: candidate.id, reason: 'EVENT_OUT_OF_ORDER: older event cannot override newer state.' };
  }
  const stale = plan.action === 'NOOP' && plan.reason.startsWith('EVENT_OUT_OF_ORDER');
  if (unknown.length && !stale) {
    await repository.createAlert({ severity: 'warning', alertType: classified.preconsultRequired ? 'unknown_service_in_qualifying_booking' : 'unknown_target_service', message: `Service-policy review for ${event.customer.name}`, context: { gmailMessageId: message.id, services: unknown.map((c) => c.serviceName), timelyBookingId: event.source.timelyBookingId } });
  }
  // Cancellation matching must not be blocked merely because a toner/root add-on is unclassified.
  if (unknown.length && !classified.preconsultRequired && event.eventType !== 'CANCELLED' && !stale) {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'manual_review', identityResolution: resolution(event) });
    return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: 'Unknown target service; no policy guessed.' };
  }
  if (event.eventType === 'CHANGED' && classified.preconsultRequired && timing !== 'PAST' && plan.action === 'NEEDS_REVIEW'
    && !plan.reason.startsWith('IDENTIFIER_CONFLICT') && !plan.reason.startsWith('CANCELLED_BOOKING_RESURRECTION_BLOCKED')
    && Boolean(event.source.timelyBookingId || event.source.timelyChangeToken)
    && candidates.filter((b) => identityCompatible(event, b)).length === 0) {
    plan = { action: 'CREATE', reason: 'RECOVERED_FROM_VERIFIED_CHANGED_EVENT: distinct verified future booking.' };
  }
  if (plan.action === 'CREATE' && (excluded || timing === 'PAST')) {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'ignored', identityResolution: resolution(event) });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: timing === 'PAST' ? 'Past confirmation retained; no active workflow created.' : 'Non-target service.' };
  }
  if (excluded && plan.action === 'NEEDS_REVIEW' && candidates.length === 0) {
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'ignored', identityResolution: resolution(event) });
    return { gmailMessageId: message.id, status: 'IGNORED', outcome: 'Non-target event without a booking.' };
  }
  if (plan.action === 'NEEDS_REVIEW') {
    if (event.eventType === 'CANCELLED') await repository.holdCancellationForReview?.(event, message.id);
    await repository.createAlert({ severity: plan.reason.startsWith('IDENTIFIER_CONFLICT') ? 'critical' : 'warning', alertType: plan.reason.startsWith('IDENTIFIER_CONFLICT') ? 'identifier_conflict' : 'booking_reconciliation_review', message: `Timely ${event.eventType.toLowerCase()} requires deterministic review.`, context: { gmailMessageId: message.id, reason: plan.reason, candidates: plan.candidates } });
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'manual_review', error: plan.reason, identityResolution: plan.reason.startsWith('IDENTIFIER_CONFLICT') ? 'IDENTIFIER_CONFLICT' : resolution(event) });
    return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: plan.reason };
  }
  let applied: { bookingId?: string; outcome: string };
  try {
    applied = await repository.applyPlan({ message, event, plan, classifications: classified.classifications, timing });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.startsWith('IDENTIFIER_CONFLICT')) throw error;
    await repository.createAlert({ severity: 'critical', alertType: 'identifier_conflict', message: `Stable Timely identity conflict for ${event.customer.name}`, context: { gmailMessageId: message.id, error: text } });
    await repository.finishEvent({ gmailMessageId: message.id, parseStatus: 'manual_review', error: text, identityResolution: 'IDENTIFIER_CONFLICT' });
    return { gmailMessageId: message.id, status: 'MANUAL_REVIEW', outcome: text };
  }
  await repository.finishEvent({ gmailMessageId: message.id, bookingId: applied.bookingId, parseStatus: 'parsed', identityResolution: stale ? 'EVENT_OUT_OF_ORDER' : resolution(event) });
  if (!stale && classified.preconsultRequired && timing === 'SAME_DAY_URGENT' && event.eventType !== 'CANCELLED') {
    await repository.createAlert({ severity: 'info', alertType: 'same_day_booking', message: `Same-day qualifying appointment for ${event.customer.name}.`, context: { gmailMessageId: message.id, bookingId: applied.bookingId } });
  }
  return { gmailMessageId: message.id, status: 'PROCESSED', outcome: applied.outcome, bookingId: applied.bookingId };
}
