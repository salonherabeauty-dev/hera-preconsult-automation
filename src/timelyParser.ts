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

function parseEventType(subject: string, body: string): TimelyEventType {
  const haystack = `${subject}\n${body}`.toLowerCase();
  if (haystack.includes('appointment cancelled')) return 'CANCELLED';
  if (haystack.includes('appointment changed')) return 'CHANGED';
  if (haystack.includes('appointment confirmed')) return 'CONFIRMED';
  throw new Error('TIMELY_EMAIL_UNKNOWN_EVENT_TYPE');
}

function parseClock(clock: string): { hour: number; minute: number } {
  const m = clock.match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (!m) throw new Error(`TIMELY_INVALID_CLOCK:${clock}`);
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3].toUpperCase();
  if (hour === 12) hour = 0;
  if (meridiem === 'PM') hour += 12;
  return { hour, minute };
}

export function parseTimelyDisplayDate(text: string): string {
  const cleaned = text.replace(/^[A-Z][a-z]{2},\s*/, '').trim();
  const m = cleaned.match(/^(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+(\d{1,2}:\d{2}(?:AM|PM))$/);
  if (!m) throw new Error(`TIMELY_INVALID_APPOINTMENT_DATE:${text}`);
  const [, day, monthName, year, clock] = m;
  const month = MONTHS[monthName];
  if (!month) throw new Error(`TIMELY_INVALID_MONTH:${monthName}`);
  const { hour, minute } = parseClock(clock);
  return `${year}-${month}-${String(Number(day)).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
}

function parseShortChangedDate(text: string, inferredYear: number): string | undefined {
  const m = text.trim().match(/^(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{1,2}:\d{2}(?:AM|PM))$/);
  if (!m) return undefined;
  const [, day, monthName, clock] = m;
  const month = MONTHS[monthName];
  if (!month) return undefined;
  const { hour, minute } = parseClock(clock);
  return `${inferredYear}-${month}-${String(Number(day)).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
}

function parseMainAppointmentText(lines: string[]): string {
  const dateLine = lines.find((line) => /^[A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\s+\d{1,2}:\d{2}(?:AM|PM)$/.test(line));
  if (!dateLine) throw new Error('TIMELY_APPOINTMENT_DATE_NOT_FOUND');
  return dateLine;
}

function parseServices(lines: string[], appointmentLine: string): TimelyServiceLine[] {
  const start = lines.indexOf(appointmentLine) + 1;
  const end = lines.findIndex((line, index) => index >= start && line.startsWith('Total price:'));
  if (start <= 0 || end < 0) throw new Error('TIMELY_SERVICE_SECTION_NOT_FOUND');

  const services: TimelyServiceLine[] = [];
  for (const line of lines.slice(start, end)) {
    if (/^:\s*\$/.test(line)) continue;
    if (line.startsWith('Cancellation reason:')) continue;
    const match = line.match(/^(.*?)\s+with\s+(.+?)\s+at\s+(\d{1,2}:\d{2}(?:AM|PM))$/);
    if (!match) continue;
    services.push({
      serviceName: match[1].trim(),
      staffName: match[2].trim(),
      serviceTime: match[3].trim()
    });
  }

  if (!services.length) throw new Error('TIMELY_SERVICE_LINES_NOT_FOUND');
  return services;
}

function parseCustomer(lines: string[]): TimelyAppointmentEvent['customer'] {
  const idx = lines.indexOf('Customer details');
  if (idx < 0) throw new Error('TIMELY_CUSTOMER_SECTION_NOT_FOUND');

  const section = lines.slice(idx + 1, Math.min(lines.length, idx + 12));
  const name = section[0];
  if (!name) throw new Error('TIMELY_CUSTOMER_NAME_NOT_FOUND');

  const editLine = section.find((line) => /app\.gettimely\.com\/customer\/customers\/(\d+)/.test(line));
  const email = section.find((line) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line));
  const mobileLine = section.find((line) => /^Mobile:\s*/i.test(line));

  return {
    name,
    email,
    mobile: mobileLine?.replace(/^Mobile:\s*/i, '').trim(),
    timelyCustomerId: editLine?.match(/customers\/(\d+)/)?.[1]
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

function parseSource(body: string): TimelyAppointmentEvent['source'] {
  const online = /Appointment created from online booking process/i.test(body);
  const changedBy = body.match(/The following appointment(?: time)? has been changed by ([^:\n]+):/i)?.[1]?.trim();
  const staffCreation = /Appointment created by (?!customer)([^\n.]+)/i.test(body);
  return {
    bookingOrigin: online ? 'ONLINE' : staffCreation ? 'STAFF' : 'UNKNOWN',
    changedBy
  };
}

function parsePreviousDate(body: string, newIso: string): { previousDisplayText?: string; previousLocalIso?: string } {
  const match = body.match(/Appointment date changed[^\n]*from\s+(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{1,2}:\d{2}(?:AM|PM))\s+to\s+(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{1,2}:\d{2}(?:AM|PM))/i);
  if (!match) return {};
  const inferredYear = Number(newIso.slice(0, 4));
  return {
    previousDisplayText: match[1],
    previousLocalIso: parseShortChangedDate(match[1], inferredYear)
  };
}

export function parseTimelyEmail(input: { subject: string; body: string; gmailMessageId?: string }): TimelyAppointmentEvent {
  const { subject, body, gmailMessageId } = input;
  const lines = normalizeLines(body);
  const eventType = parseEventType(subject, body);
  const appointmentText = parseMainAppointmentText(lines);
  const localIso = parseTimelyDisplayDate(appointmentText);
  const services = parseServices(lines, appointmentText);
  const customer = parseCustomer(lines);
  const warnings: string[] = [];

  if (!customer.mobile) warnings.push('CUSTOMER_MOBILE_MISSING');
  if (!customer.timelyCustomerId) warnings.push('TIMELY_CUSTOMER_ID_MISSING');
  if (!customer.email) warnings.push('CUSTOMER_EMAIL_MISSING');

  const previous = eventType === 'CHANGED' ? parsePreviousDate(body, localIso) : {};
  if (eventType === 'CHANGED' && !previous.previousLocalIso) warnings.push('PREVIOUS_APPOINTMENT_TIME_NOT_FOUND');

  return {
    parserVersion: 'TIMELY_EMAIL_V1',
    eventType,
    subject,
    gmailMessageId,
    customer,
    appointment: {
      localIso,
      displayText: appointmentText,
      ...previous,
      locationName: parseLocation(lines),
      totalPrice: parsePrice(lines),
      cancellationReason: parseCancellationReason(lines),
      services
    },
    source: parseSource(body),
    warnings
  };
}
