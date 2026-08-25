import type { TimelyAppointmentEvent } from './types.js';
import { canonicalServiceName } from './serviceRules.js';

export interface ExistingBookingSnapshot {
  id: string;
  timelyCustomerId?: string;
  /** Stable ICS UID, normally BG... */
  timelyBookingId?: string;
  /** UUID from Timely's booking/change URL. */
  timelyChangeToken?: string;
  mobile?: string;
  email?: string;
  appointmentLocalIso: string;
  locationName?: string;
  serviceNames: string[];
  lastTimelyEventAt?: string;
  status: 'CONFIRMED' | 'CANCELLED';
}

export type ReconciliationPlan =
  | { action: 'CREATE'; reason: string }
  | { action: 'UPDATE'; bookingId: string; reason: string }
  | { action: 'CANCEL'; bookingId: string; reason: string }
  | { action: 'NOOP'; bookingId: string; reason: string }
  | { action: 'NEEDS_REVIEW'; reason: string; candidates: string[] };

function canon(value: string): string {
  return canonicalServiceName(value);
}

function normalizeMobile(value: string): string {
  return value.replace(/\D/g, '');
}

function sameInstant(a: string, b: string): boolean {
  const aa = new Date(a).getTime();
  const bb = new Date(b).getTime();
  return Number.isFinite(aa) && Number.isFinite(bb) && aa === bb;
}

function sameServicesOrdered(a: string[], b: string[]): boolean {
  const aa = a.map(canon);
  const bb = b.map(canon);
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
}

function sameLocation(event: TimelyAppointmentEvent, booking: ExistingBookingSnapshot): boolean {
  const eventLocation = event.appointment.locationName;
  if (!eventLocation || !booking.locationName) return false;
  return canon(eventLocation) === canon(booking.locationName);
}

function sameCustomer(event: TimelyAppointmentEvent, booking: ExistingBookingSnapshot): boolean {
  if (event.customer.timelyCustomerId && booking.timelyCustomerId) {
    return event.customer.timelyCustomerId === booking.timelyCustomerId;
  }

  let compared = false;
  if (event.customer.email && booking.email) {
    compared = true;
    if (canon(event.customer.email) !== canon(booking.email)) return false;
  }
  if (event.customer.mobile && booking.mobile) {
    compared = true;
    if (normalizeMobile(event.customer.mobile) !== normalizeMobile(booking.mobile)) return false;
  }
  return compared;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function stableIdentityMatches(
  event: TimelyAppointmentEvent,
  existing: ExistingBookingSnapshot[],
): { match?: ExistingBookingSnapshot; conflict?: ReconciliationPlan } {
  const uid = event.source.timelyBookingId;
  const token = event.source.timelyChangeToken;
  if (!uid && !token) return {};

  const uidMatches = uid ? existing.filter((booking) => booking.timelyBookingId === uid) : [];
  const tokenMatches = token ? existing.filter((booking) => (
    booking.timelyChangeToken === token
    || (!booking.timelyChangeToken && booking.timelyBookingId === token && isUuid(token))
  )) : [];

  const combined = [...new Map([...uidMatches, ...tokenMatches].map((booking) => [booking.id, booking])).values()];
  if (uidMatches.length > 1 || tokenMatches.length > 1 || combined.length > 1) {
    return {
      conflict: {
        action: 'NEEDS_REVIEW',
        reason: 'IDENTIFIER_CONFLICT: Timely UID/change token resolves to multiple bookings.',
        candidates: combined.map((booking) => booking.id),
      },
    };
  }

  return { match: combined[0] };
}

function stableIdentityPlan(
  event: TimelyAppointmentEvent,
  existing: ExistingBookingSnapshot[],
): ReconciliationPlan | null {
  const resolved = stableIdentityMatches(event, existing);
  if (resolved.conflict) return resolved.conflict;
  const match = resolved.match;
  if (!match) return null;

  if (event.eventType === 'CANCELLED') {
    if (match.status === 'CANCELLED') {
      return { action: 'NOOP', bookingId: match.id, reason: 'Stable Timely identity is already cancelled.' };
    }
    return { action: 'CANCEL', bookingId: match.id, reason: 'Matched stable Timely UID/change token.' };
  }

  if (match.status === 'CANCELLED') {
    return {
      action: 'NEEDS_REVIEW',
      reason: 'CANCELLED_BOOKING_RESURRECTION_BLOCKED: a confirmed/changed event matched a cancelled booking.',
      candidates: [match.id],
    };
  }

  if (event.eventType === 'CHANGED') {
    return { action: 'UPDATE', bookingId: match.id, reason: 'Matched stable Timely UID/change token.' };
  }

  const services = event.appointment.services.map((service) => service.serviceName);
  if (
    sameInstant(match.appointmentLocalIso, event.appointment.localIso)
    && sameServicesOrdered(match.serviceNames, services)
    && sameLocation(event, match)
  ) {
    return { action: 'NOOP', bookingId: match.id, reason: 'Stable Timely identity already has identical details.' };
  }
  return { action: 'UPDATE', bookingId: match.id, reason: 'Stable Timely identity matched updated confirmation details.' };
}

export function planReconciliation(
  event: TimelyAppointmentEvent,
  existing: ExistingBookingSnapshot[],
): ReconciliationPlan {
  const services = event.appointment.services.map((service) => service.serviceName);

  const stablePlan = stableIdentityPlan(event, existing);
  if (stablePlan) return stablePlan;

  const customerMatches = existing.filter((booking) => sameCustomer(event, booking));

  if (event.eventType === 'CONFIRMED') {
    const exactActive = customerMatches.filter((booking) => (
      booking.status === 'CONFIRMED'
      && sameInstant(booking.appointmentLocalIso, event.appointment.localIso)
      && sameLocation(event, booking)
      && sameServicesOrdered(booking.serviceNames, services)
    ));
    if (exactActive.length === 1) {
      return {
        action: 'NOOP',
        bookingId: exactActive[0].id,
        reason: 'Exact active customer, appointment, location and ordered service block already exist.',
      };
    }
    if (exactActive.length > 1) {
      return {
        action: 'NEEDS_REVIEW',
        reason: 'Multiple active bookings match the exact confirmed composite.',
        candidates: exactActive.map((booking) => booking.id),
      };
    }

    const exactCancelled = customerMatches.filter((booking) => (
      booking.status === 'CANCELLED'
      && sameInstant(booking.appointmentLocalIso, event.appointment.localIso)
      && sameLocation(event, booking)
      && sameServicesOrdered(booking.serviceNames, services)
    ));
    if (exactCancelled.length) {
      return {
        action: 'NEEDS_REVIEW',
        reason: 'CANCELLED_BOOKING_RESURRECTION_BLOCKED: confirmed event matches a cancelled booking.',
        candidates: exactCancelled.map((booking) => booking.id),
      };
    }
    return { action: 'CREATE', reason: 'No existing active booking matched the confirmed event.' };
  }

  if (event.eventType === 'CHANGED') {
    if (event.appointment.previousLocalIso) {
      const previous = customerMatches.filter((booking) => (
        booking.status === 'CONFIRMED'
        && sameInstant(booking.appointmentLocalIso, event.appointment.previousLocalIso!)
        && sameLocation(event, booking)
      ));
      if (previous.length === 1) {
        return { action: 'UPDATE', bookingId: previous[0].id, reason: 'Matched previous appointment time + customer + location.' };
      }
      if (previous.length > 1) {
        return {
          action: 'NEEDS_REVIEW',
          reason: 'Multiple bookings match the previous appointment composite.',
          candidates: previous.map((booking) => booking.id),
        };
      }
    }

    const sameTimeCandidates = customerMatches.filter((booking) => (
      booking.status === 'CONFIRMED'
      && sameInstant(booking.appointmentLocalIso, event.appointment.localIso)
      && sameLocation(event, booking)
    ));
    if (sameTimeCandidates.length === 1) {
      return {
        action: 'UPDATE',
        bookingId: sameTimeCandidates[0].id,
        reason: 'Matched same active customer + appointment time + location; service set may have changed.',
      };
    }
    if (sameTimeCandidates.length > 1) {
      return {
        action: 'NEEDS_REVIEW',
        reason: 'Multiple active bookings match the changed appointment composite.',
        candidates: sameTimeCandidates.map((booking) => booking.id),
      };
    }

    const serviceCandidates = customerMatches.filter((booking) => (
      booking.status === 'CONFIRMED'
      && sameLocation(event, booking)
      && sameServicesOrdered(booking.serviceNames, services)
    ));
    if (serviceCandidates.length === 1) {
      return {
        action: 'UPDATE',
        bookingId: serviceCandidates[0].id,
        reason: 'Single active customer booking matched location + complete ordered service block.',
      };
    }
    return {
      action: 'NEEDS_REVIEW',
      reason: 'Changed event could not be matched deterministically.',
      candidates: serviceCandidates.map((booking) => booking.id),
    };
  }

  const alreadyCancelled = customerMatches.filter((booking) => (
    booking.status === 'CANCELLED'
    && sameInstant(booking.appointmentLocalIso, event.appointment.localIso)
    && sameLocation(event, booking)
    && sameServicesOrdered(booking.serviceNames, services)
  ));
  if (alreadyCancelled.length === 1) {
    return { action: 'NOOP', bookingId: alreadyCancelled[0].id, reason: 'Exact matching booking is already cancelled.' };
  }
  if (alreadyCancelled.length > 1) {
    return {
      action: 'NEEDS_REVIEW',
      reason: 'Cancellation matches multiple already-cancelled bookings.',
      candidates: alreadyCancelled.map((booking) => booking.id),
    };
  }

  const exactCancellation = customerMatches.filter((booking) => (
    booking.status === 'CONFIRMED'
    && sameInstant(booking.appointmentLocalIso, event.appointment.localIso)
    && sameLocation(event, booking)
    && sameServicesOrdered(booking.serviceNames, services)
  ));
  if (exactCancellation.length === 1) {
    return {
      action: 'CANCEL',
      bookingId: exactCancellation[0].id,
      reason: 'Exact customer + appointment + location + ordered service block matched cancellation.',
    };
  }
  if (exactCancellation.length > 1) {
    return {
      action: 'NEEDS_REVIEW',
      reason: 'Cancellation matched multiple active bookings.',
      candidates: exactCancellation.map((booking) => booking.id),
    };
  }

  return {
    action: 'NEEDS_REVIEW',
    reason: 'Cancellation has no deterministic active-booking match.',
    candidates: [],
  };
}
