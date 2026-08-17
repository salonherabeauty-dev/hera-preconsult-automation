import type { TimelyAppointmentEvent } from './types.js';

export interface ExistingBookingSnapshot {
  id: string;
  timelyCustomerId?: string;
  timelyBookingId?: string;
  mobile?: string;
  email?: string;
  appointmentLocalIso: string;
  serviceNames: string[];
  status: 'CONFIRMED' | 'CANCELLED';
}

export type ReconciliationPlan =
  | { action: 'CREATE'; reason: string }
  | { action: 'UPDATE'; bookingId: string; reason: string }
  | { action: 'CANCEL'; bookingId: string; reason: string }
  | { action: 'NOOP'; bookingId: string; reason: string }
  | { action: 'NEEDS_REVIEW'; reason: string; candidates: string[] };

function canon(value: string): string {
  return value.normalize('NFKD').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameInstant(a: string, b: string): boolean {
  const aa = new Date(a).getTime();
  const bb = new Date(b).getTime();
  return Number.isFinite(aa) && Number.isFinite(bb) && aa === bb;
}

function sameServices(a: string[], b: string[]): boolean {
  const aa = a.map(canon).sort();
  const bb = b.map(canon).sort();
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

function sameCustomer(event: TimelyAppointmentEvent, booking: ExistingBookingSnapshot): boolean {
  if (event.customer.timelyCustomerId && booking.timelyCustomerId) {
    return event.customer.timelyCustomerId === booking.timelyCustomerId;
  }
  if (event.customer.mobile && booking.mobile) return event.customer.mobile === booking.mobile;
  if (event.customer.email && booking.email) return canon(event.customer.email) === canon(booking.email);
  return false;
}

function stableBookingPlan(
  event: TimelyAppointmentEvent,
  existing: ExistingBookingSnapshot[],
): ReconciliationPlan | null {
  const timelyBookingId = event.source.timelyBookingId;
  if (!timelyBookingId) return null;
  const matches = existing.filter((b) => b.timelyBookingId === timelyBookingId);
  if (matches.length > 1) {
    return {
      action: 'NEEDS_REVIEW',
      reason: 'Multiple database bookings share the same Timely booking reference.',
      candidates: matches.map((b) => b.id),
    };
  }
  const match = matches[0];
  if (!match) return null;

  if (event.eventType === 'CANCELLED') {
    if (match.status === 'CANCELLED') return { action: 'NOOP', bookingId: match.id, reason: 'Timely booking reference is already cancelled.' };
    return { action: 'CANCEL', bookingId: match.id, reason: 'Matched stable Timely booking reference.' };
  }

  if (match.status === 'CANCELLED') {
    return {
      action: 'NEEDS_REVIEW',
      reason: 'A confirmed/changed Timely event matched a database booking already marked cancelled.',
      candidates: [match.id],
    };
  }

  if (event.eventType === 'CHANGED') {
    return { action: 'UPDATE', bookingId: match.id, reason: 'Matched stable Timely booking reference.' };
  }

  const services = event.appointment.services.map((s) => s.serviceName);
  if (sameInstant(match.appointmentLocalIso, event.appointment.localIso) && sameServices(match.serviceNames, services)) {
    return { action: 'NOOP', bookingId: match.id, reason: 'Stable Timely booking reference already exists with identical details.' };
  }
  return { action: 'UPDATE', bookingId: match.id, reason: 'Stable Timely booking reference matched updated confirmation details.' };
}

export function planReconciliation(
  event: TimelyAppointmentEvent,
  existing: ExistingBookingSnapshot[]
): ReconciliationPlan {
  const services = event.appointment.services.map((s) => s.serviceName);

  // Highest-confidence reconciliation: customer-facing Timely notifications contain
  // a stable booking UUID in the change/cancel URL. Prefer this over names/times.
  const stablePlan = stableBookingPlan(event, existing);
  if (stablePlan) return stablePlan;

  const customerMatches = existing.filter((b) => sameCustomer(event, b));

  if (event.eventType === 'CONFIRMED') {
    const exactActive = customerMatches.find(
      (b) => b.status === 'CONFIRMED' && sameInstant(b.appointmentLocalIso, event.appointment.localIso) && sameServices(b.serviceNames, services)
    );
    if (exactActive) return { action: 'NOOP', bookingId: exactActive.id, reason: 'Exact active customer, appointment time and service set already exist.' };

    const exactCancelled = customerMatches.filter(
      (b) => b.status === 'CANCELLED' && sameInstant(b.appointmentLocalIso, event.appointment.localIso) && sameServices(b.serviceNames, services)
    );
    if (exactCancelled.length) {
      return {
        action: 'NEEDS_REVIEW',
        reason: 'Confirmed event matches a previously cancelled booking and must not be resurrected automatically.',
        candidates: exactCancelled.map((b) => b.id),
      };
    }
    return { action: 'CREATE', reason: 'No existing active booking matched confirmed event.' };
  }

  if (event.eventType === 'CHANGED') {
    if (event.appointment.previousLocalIso) {
      const previousIso = event.appointment.previousLocalIso;
      const previous = customerMatches.filter(
        (b) => sameInstant(b.appointmentLocalIso, previousIso) && b.status === 'CONFIRMED'
      );
      if (previous.length === 1) {
        return { action: 'UPDATE', bookingId: previous[0].id, reason: 'Matched Timely previous appointment time from Recent activity.' };
      }
      if (previous.length > 1) {
        return { action: 'NEEDS_REVIEW', reason: 'Multiple bookings match previous appointment time.', candidates: previous.map((b) => b.id) };
      }
    }

    // A service-only change can keep the same appointment time while changing the
    // service set completely. Same customer + same active appointment instant is
    // deterministic and avoids leaving an old qualifying service stuck in scope.
    const sameTimeCandidates = customerMatches.filter(
      (b) => b.status === 'CONFIRMED' && sameInstant(b.appointmentLocalIso, event.appointment.localIso)
    );
    if (sameTimeCandidates.length === 1) {
      return { action: 'UPDATE', bookingId: sameTimeCandidates[0].id, reason: 'Matched same active customer + appointment time; service set may have changed.' };
    }
    if (sameTimeCandidates.length > 1) {
      return { action: 'NEEDS_REVIEW', reason: 'Multiple active bookings match the changed appointment time.', candidates: sameTimeCandidates.map((b) => b.id) };
    }

    const serviceCandidates = customerMatches.filter((b) => b.status === 'CONFIRMED' && sameServices(b.serviceNames, services));
    if (serviceCandidates.length === 1) {
      return { action: 'UPDATE', bookingId: serviceCandidates[0].id, reason: 'Single active customer booking matched same service set.' };
    }
    return {
      action: 'NEEDS_REVIEW',
      reason: 'Changed event could not be matched deterministically.',
      candidates: serviceCandidates.map((b) => b.id)
    };
  }

  const alreadyCancelled = customerMatches.filter(
    (b) => sameInstant(b.appointmentLocalIso, event.appointment.localIso) && b.status === 'CANCELLED' && sameServices(b.serviceNames, services)
  );
  if (alreadyCancelled.length === 1) {
    return { action: 'NOOP', bookingId: alreadyCancelled[0].id, reason: 'Matching booking is already cancelled.' };
  }
  if (alreadyCancelled.length > 1) {
    return { action: 'NEEDS_REVIEW', reason: 'Cancellation matches multiple already-cancelled bookings.', candidates: alreadyCancelled.map((b) => b.id) };
  }

  const exactCancellation = customerMatches.filter(
    (b) => sameInstant(b.appointmentLocalIso, event.appointment.localIso) && b.status === 'CONFIRMED'
  );
  if (exactCancellation.length === 1) {
    return { action: 'CANCEL', bookingId: exactCancellation[0].id, reason: 'Exact customer + appointment time matched cancellation.' };
  }
  if (exactCancellation.length > 1) {
    const sameService = exactCancellation.filter((b) => sameServices(b.serviceNames, services));
    if (sameService.length === 1) {
      return { action: 'CANCEL', bookingId: sameService[0].id, reason: 'Resolved cancellation using service set.' };
    }
    return { action: 'NEEDS_REVIEW', reason: 'Cancellation matched multiple active bookings.', candidates: exactCancellation.map((b) => b.id) };
  }

  return { action: 'NEEDS_REVIEW', reason: 'Cancellation has no deterministic active-booking match.', candidates: [] };
}
