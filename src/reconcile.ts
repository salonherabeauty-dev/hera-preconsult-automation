import type { TimelyAppointmentEvent } from './types.js';

export interface ExistingBookingSnapshot {
  id: string;
  timelyCustomerId?: string;
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

export function planReconciliation(
  event: TimelyAppointmentEvent,
  existing: ExistingBookingSnapshot[]
): ReconciliationPlan {
  const services = event.appointment.services.map((s) => s.serviceName);
  const customerMatches = existing.filter((b) => sameCustomer(event, b));

  if (event.eventType === 'CONFIRMED') {
    const exact = customerMatches.find(
      (b) => sameInstant(b.appointmentLocalIso, event.appointment.localIso) && sameServices(b.serviceNames, services)
    );
    if (exact) return { action: 'NOOP', bookingId: exact.id, reason: 'Exact booking already exists.' };
    return { action: 'CREATE', reason: 'No existing booking matched confirmed event.' };
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
