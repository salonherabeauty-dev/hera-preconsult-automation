import type { TimelyAppointmentEvent } from './types.js';

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// FNV-1a 64-bit style deterministic non-cryptographic fingerprint.
// This is for stable matching/deduplication, not security.
function stableHash(input: string): string {
  let h1 = 0xcbf29ce4;
  let h2 = 0x84222325;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function bookingFingerprint(event: TimelyAppointmentEvent): string {
  const customer = event.customer.timelyCustomerId ?? event.customer.mobile ?? event.customer.email ?? event.customer.name;
  const services = event.appointment.services.map((s) => normalize(s.serviceName)).sort().join('|');
  const raw = `${customer}|${event.appointment.localIso}|${normalize(event.appointment.locationName ?? '')}|${services}`;
  return stableHash(raw);
}

export function previousBookingFingerprint(event: TimelyAppointmentEvent): string | undefined {
  if (!event.appointment.previousLocalIso) return undefined;
  const clone: TimelyAppointmentEvent = {
    ...event,
    appointment: { ...event.appointment, localIso: event.appointment.previousLocalIso }
  };
  return bookingFingerprint(clone);
}

export function gmailEventDedupeKey(event: TimelyAppointmentEvent): string | undefined {
  return event.gmailMessageId ? `gmail:${event.gmailMessageId}` : undefined;
}
