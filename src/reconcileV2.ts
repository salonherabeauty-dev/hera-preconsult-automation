import { planReconciliation, type ExistingBookingSnapshot, type ReconciliationPlan } from './reconcile.js';
import { canonicalServiceName } from './serviceRules.js';
import type { TimelyAppointmentEvent, TimelyServiceLine } from './types.js';

export interface VerifiedBookingSnapshot extends ExistingBookingSnapshot {
  identityAliases?: Array<{ identifierType: 'ics_uid' | 'change_token'; identifierValue: string }>;
  serviceDetails?: TimelyServiceLine[];
}
function alias(b: VerifiedBookingSnapshot, kind: 'ics_uid' | 'change_token', value?: string): boolean {
  return Boolean(value && b.identityAliases?.some((i) => i.identifierType === kind && i.identifierValue === value));
}
function uidMatches(b: VerifiedBookingSnapshot, uid?: string): boolean {
  return Boolean(uid && (b.timelyBookingId === uid || alias(b, 'ics_uid', uid)));
}
function tokenMatches(b: VerifiedBookingSnapshot, token?: string): boolean {
  return Boolean(token && (b.timelyChangeToken === token || alias(b, 'change_token', token)
    || (!b.timelyChangeToken && b.timelyBookingId === token && /^[0-9a-f-]{36}$/i.test(token))));
}
/** Distinct verified IDs must not be merged merely because a person or service matches. */
export function identityCompatible(event: TimelyAppointmentEvent, b: VerifiedBookingSnapshot): boolean {
  const uid = event.source.timelyBookingId;
  const token = event.source.timelyChangeToken;
  if (uidMatches(b, uid) || tokenMatches(b, token)) return true;
  if (uid && b.timelyBookingId && uid !== b.timelyBookingId) return false;
  if (token && b.timelyChangeToken && token !== b.timelyChangeToken) return false;
  return true;
}
function sameServiceDetails(event: TimelyAppointmentEvent, b: VerifiedBookingSnapshot): boolean {
  if (!b.serviceDetails) return true; // Legacy unit-test repository only has service names.
  return event.appointment.services.length === b.serviceDetails.length && event.appointment.services.every((s, index) => {
    const old = b.serviceDetails![index];
    return ['serviceName', 'staffName', 'serviceTime'].every((key) =>
      canonicalServiceName(s[key as keyof TimelyServiceLine] ?? '') === canonicalServiceName(old[key as keyof TimelyServiceLine] ?? ''));
  });
}
function review(reason: string, matches: VerifiedBookingSnapshot[]): ReconciliationPlan {
  return { action: 'NEEDS_REVIEW', reason, candidates: matches.map((b) => b.id) };
}
export function planReconciliationV2(event: TimelyAppointmentEvent, existing: VerifiedBookingSnapshot[]): ReconciliationPlan {
  const uid = event.source.timelyBookingId;
  const token = event.source.timelyChangeToken;
  const uidOwners = existing.filter((b) => uidMatches(b, uid));
  const tokenOwners = existing.filter((b) => tokenMatches(b, token));
  const owners = [...new Map([...uidOwners, ...tokenOwners].map((b) => [b.id, b])).values()];
  if (owners.length > 1) return review('IDENTIFIER_CONFLICT: UID and token have different owners.', owners);
  if (owners.length === 1) {
    const b = owners[0];
    const legacy = Boolean(token && b.timelyBookingId === token && !b.timelyChangeToken);
    if (uid && b.timelyBookingId && !uidMatches(b, uid) && !legacy) {
      return review('IDENTIFIER_CONFLICT: token cannot move to a different ICS UID.', [b]);
    }
    if (token && b.timelyChangeToken && !tokenMatches(b, token) && !uidMatches(b, uid)) {
      return review('IDENTIFIER_CONFLICT: token rotation requires the same verified ICS UID.', [b]);
    }
    if (event.eventType === 'CANCELLED') return { action: b.status === 'CANCELLED' ? 'NOOP' : 'CANCEL', bookingId: b.id, reason: 'Matched verified Timely identity or historical alias.' };
    if (b.status === 'CANCELLED') return review('CANCELLED_BOOKING_RESURRECTION_BLOCKED: same verified booking is cancelled.', [b]);
    if (event.eventType === 'CHANGED') return { action: 'UPDATE', bookingId: b.id, reason: 'Matched verified Timely UID/token; token aliases preserved atomically.' };
    const sameTime = Date.parse(b.appointmentLocalIso) === Date.parse(event.appointment.localIso);
    const sameLocation = Boolean(b.locationName && event.appointment.locationName && canonicalServiceName(b.locationName) === canonicalServiceName(event.appointment.locationName));
    const sameNames = b.serviceNames.length === event.appointment.services.length && b.serviceNames.every((s, i) => canonicalServiceName(s) === canonicalServiceName(event.appointment.services[i].serviceName));
    return { action: sameTime && sameLocation && sameNames && sameServiceDetails(event, b) ? 'NOOP' : 'UPDATE', bookingId: b.id, reason: 'Matched verified booking; complete authoritative service block reconciled.' };
  }
  const compatible = existing.filter((b) => identityCompatible(event, b));
  const plan = planReconciliation(event, compatible);
  if (event.eventType === 'CANCELLED' && (plan.action === 'CANCEL' || plan.action === 'NOOP')) {
    const match = compatible.find((b) => b.id === plan.bookingId);
    if (match && !sameServiceDetails(event, match)) return review('Cancellation service/staff/time block requires deterministic review.', [match]);
  }
  return plan;
}
