import type { TimelyAppointmentEvent, TimelyEventType, TimelyServiceLine } from './types.js';

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

function normalizeLines(body: string): string[] {
  return body
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function looksLikeTimelyLifecycleMessage(subject: string, body: string): boolean {
  return /\bAppointment\s+(confirmed|changed|cancelled)\b/i.test(`${subject}\n${body}`);
}

function parseEventType(subject: string, body: string): TimelyEventType {
  const haystack = `${subject}\n${body}`.toLowerCase();
  if (/appointment\s+cancelled/.test(haystack)) return 'CANCELLED';
  if (/appointment\s+changed/.test(haystack)) return 'CHANGED';
  if (/appointment\s+confirmed/.test(haystack)) return 'CONFIRMED';
  throw new Error('TIMELY_EMAIL_UNKNOWN_EVENT_TYPE');
}

function parseClock(clock: string): { hour: number; minute: number } {
  const m = clock.match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (!m) throw new Error(`TIMELY_INVALID_CLOCK:${clock}`);
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) throw new Error(`TIMELY_INVALID_CLOCK:${clock}`);
  const meridiem = m[3].toUpperCase();
  if (hour === 12) hour = 0;
  if (meridiem === 'PM') hour += 12;
  return { hour, minute };
}

function isoFromParts(day: string, monthName: string, year: string, clock: string): string {
  const month = MONTHS[monthName];
  if (!month) throw new Error(`TIMELY_INVALID_MONTH:${monthName}`);
  const { hour, minute } = parseClock(clock);
  return `${year}-${month}-${String(Number(day)).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
}

/**
 * Parse Timely's displayed appointment date. V1 admin notifications include the
 * time on the date line; V2 customer notifications put the time on the service
 * line, so fallbackClock is used for that format.
 */
export function parseTimelyDisplayDate(text: string, fallbackClock?: string): string {
  const cleaned = text.replace(/^[A-Z][a-z]{2},\s*/, '').trim();
  const withClock = cleaned.match(/^(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+(\d{1,2}:\d{2}(?:AM|PM))$/);
  if (withClock) return isoFromParts(withClock[1], withClock[2], withClock[3], withClock[4]);

  const dateOnly = cleaned.match(/^(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})$/);
  if (dateOnly && fallbackClock) return isoFromParts(dateOnly[1], dateOnly[2], dateOnly[3], fallbackClock);

  throw new Error(`TIMELY_INVALID_APPOINTMENT_DATE:${text}`);
}

function parseShortChangedDate(text: string, newIso: string): string | undefined {
  const m = text.trim().match(/^(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{1,2}:\d{2}(?:AM|PM))$/);
  if (!m) return undefined;
  const [, day, monthName, clock] = m;
  const newDate = new Date(newIso);
  const newYear = Number(newIso.slice(0, 4));
  const candidates = [newYear - 1, newYear, newYear + 1]
    .map((year) => isoFromParts(day, monthName, String(year), clock))
    .map((iso) => ({ iso, distance: Math.abs(new Date(iso).getTime() - newDate.getTime()) }))
    .sort((a, b) => a.distance - b.distance);
  return candidates[0]?.iso;
}

function findAppointmentLine(lines: string[]): string {
  const combined = lines.find((line) => /^[A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\s+\d{1,2}:\d{2}(?:AM|PM)$/.test(line));
  if (combined) return combined;
  const dateOnly = lines.find((line) => /^[A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}$/.test(line));
  if (dateOnly) return dateOnly;
  throw new Error('TIMELY_APPOINTMENT_DATE_NOT_FOUND');
}

function parseServices(lines: string[], appointmentLine: string): TimelyServiceLine[] {
  const start = lines.indexOf(appointmentLine) + 1;
  if (start <= 0) throw new Error('TIMELY_SERVICE_SECTION_NOT_FOUND');

  const stopHeadings = new Set(['At this location', 'Customer details', 'Your details', 'Recent activity']);
  const services: TimelyServiceLine[] = [];
  for (const line of lines.slice(start, Math.min(lines.length, start + 40))) {
    if (stopHeadings.has(line) || line.startsWith('Total price:')) break;
    if (/^:\s*\$/.test(line) || line.startsWith('Cancellation reason:')) continue;
    const match = line.match(/^(.*?)\s+with\s+(.+?)\s+at\s+(\d{1,2}:\d{2}(?:AM|PM))$/);
    if (!match) continue;
    services.push({
      serviceName: match[1].trim(),
      staffName: match[2].trim(),
      serviceTime: match[3].trim(),
    });
  }
  if (!services.length) throw new Error('TIMELY_SERVICE_LINES_NOT_FOUND');
  return services;
}

function parseCustomer(lines: string[]): TimelyAppointmentEvent['customer'] {
  const headings = ['Customer details', 'Your details'];
  const idx = lines.findIndex((line) => headings.includes(line));
  if (idx < 0) throw new Error('TIMELY_CUSTOMER_SECTION_NOT_FOUND');

  const section = lines.slice(idx + 1, Math.min(lines.length, idx + 18));
  const name = section[0];
  if (!name) throw new Error('TIMELY_CUSTOMER_NAME_NOT_FOUND');

  const editLine = section.find((line) => /app\.gettimely\.com\/customer\/customers\/(\d+)/i.test(line));
  const email = section.find((line) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(line));
  const mobileLine = section.find((line) => /^Mobile:\s*/i.test(line));

  return {
    name,
    email,
    mobile: mobileLine?.replace(/^Mobile:\s*/i, '').trim(),
    timelyCustomerId: editLine?.match(/customers\/(\d+)/i)?.[1],
  };
}

function parseLocation(lines: string[]): string | undefined {
  const idx = lines.indexOf('At this location');
  return idx >= 0 ? lines[idx + 1] : undefined;
}

function parsePrice(lines: string[]): number | undefined {
  const line = lines.find((l) => /^Total price:\s*\$/.test(l));
  const match = line?.match(/^Total price:\s*\$([\d,]+(?:\.\d{2})?)/);
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

function parseCancellationReason(lines: string[]): string | undefined {
  return lines.find((l) => l.startsWith('Cancellation reason:'))?.replace('Cancellation reason:', '').trim();
}

function parseTimelyBookingId(body: string): string | undefined {
  return body.match(/book\.gettimely\.com\/booking\/change\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]?.toLowerCase();
}

function parseSource(body: string, lines: string[]): TimelyAppointmentEvent['source'] {
  const online = /Appointment created from online booking process/i.test(body);
  const changedBy = body.match(/The following appointment(?: time)? has been changed by ([^:\n]+):/i)?.[1]?.trim();
  const staffCreation = /Appointment created by (?!customer)([^\n.]+)/i.test(body);
  const emailFormat = lines.includes('Your details') ? 'CUSTOMER_NOTIFICATION' : 'ADMIN_NOTIFICATION';
  return {
    bookingOrigin: online ? 'ONLINE' : staffCreation ? 'STAFF' : 'UNKNOWN',
    changedBy,
    timelyBookingId: parseTimelyBookingId(body),
    emailFormat,
  };
}

function parsePreviousDate(body: string, newIso: string): { previousDisplayText?: string; previousLocalIso?: string } {
  const match = body.match(/Appointment date changed[^\n]*from\s+(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{1,2}:\d{2}(?:AM|PM))\s+to\s+(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{1,2}:\d{2}(?:AM|PM))/i);
  if (!match) return {};
  return {
    previousDisplayText: match[1],
    previousLocalIso: parseShortChangedDate(match[1], newIso),
  };
}

export function parseTimelyEmail(input: { subject: string; body: string; gmailMessageId?: string }): TimelyAppointmentEvent {
  const { subject, body, gmailMessageId } = input;
  if (!looksLikeTimelyLifecycleMessage(subject, body)) throw new Error('TIMELY_EMAIL_NOT_LIFECYCLE');

  const lines = normalizeLines(body);
  const eventType = parseEventType(subject, body);
  const appointmentLine = findAppointmentLine(lines);
  const services = parseServices(lines, appointmentLine);
  const hasClockOnDate = /\d{1,2}:\d{2}(?:AM|PM)$/.test(appointmentLine);
  const localIso = parseTimelyDisplayDate(appointmentLine, hasClockOnDate ? undefined : services[0].serviceTime);
  const customer = parseCustomer(lines);
  const source = parseSource(body, lines);
  const warnings: string[] = [];

  if (!customer.mobile) warnings.push('CUSTOMER_MOBILE_MISSING');
  if (!customer.email) warnings.push('CUSTOMER_EMAIL_MISSING');
  if (!customer.timelyCustomerId && !source.timelyBookingId) warnings.push('STABLE_TIMELY_IDENTIFIER_MISSING');

  const previous = eventType === 'CHANGED' ? parsePreviousDate(body, localIso) : {};
  if (eventType === 'CHANGED' && !previous.previousLocalIso && !source.timelyBookingId) {
    warnings.push('PREVIOUS_APPOINTMENT_TIME_NOT_FOUND');
  }

  const displayText = hasClockOnDate ? appointmentLine : `${appointmentLine} ${services[0].serviceTime}`;
  return {
    parserVersion: source.emailFormat === 'CUSTOMER_NOTIFICATION' ? 'TIMELY_EMAIL_V2' : 'TIMELY_EMAIL_V1',
    eventType,
    subject,
    gmailMessageId,
    customer,
    appointment: {
      localIso,
      displayText,
      ...previous,
      locationName: parseLocation(lines),
      totalPrice: parsePrice(lines),
      cancellationReason: parseCancellationReason(lines),
      services,
    },
    source,
    warnings,
  };
}
