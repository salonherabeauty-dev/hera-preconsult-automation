import { readFile } from 'node:fs/promises';
import { parseTimelyEmail, classifyAppointment, bookingFingerprint } from './dist/index.js';

const files = [
  ['confirmed-curly.txt', 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM'],
  ['confirmed-highlights.txt', 'Appointment confirmed for Test Highlights on Fri, 21 Aug 2026 4:00PM'],
  ['confirmed-nonbleach-balayage.txt', 'Appointment confirmed for Test Balayage on Sat, 29 Aug 2026 12:00PM'],
  ['changed-curly.txt', 'Appointment changed for Test Change on Tue, 18 Aug 2026 12:45PM'],
  ['cancelled-curly.txt', 'Appointment cancelled for Test Cancel on Sat, 5 Sep 2026 3:00PM']
];

for (const [file, subject] of files) {
  const body = await readFile(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
  const event = parseTimelyEmail({ subject, body, gmailMessageId: `demo-${file}` });
  const classification = classifyAppointment(event.appointment.services.map((s) => s.serviceName));
  console.log(JSON.stringify({
    eventType: event.eventType,
    customer: event.customer.name,
    appointment: event.appointment.localIso,
    service: event.appointment.services.map((s) => s.serviceName),
    classification,
    fingerprint: bookingFingerprint(event).slice(0, 16),
    warnings: event.warnings
  }, null, 2));
}
