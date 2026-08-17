import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTimelyEmail, classifyAppointment, bookingFingerprint, previousBookingFingerprint } from '../dist/index.js';

async function fixture(name) {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

test('parses confirmed curly booking', async () => {
  const body = await fixture('confirmed-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM', body, gmailMessageId: 'g1' });
  assert.equal(event.eventType, 'CONFIRMED');
  assert.equal(event.customer.timelyCustomerId, '10000001');
  assert.equal(event.customer.mobile, '+6590000001');
  assert.equal(event.appointment.localIso, '2026-08-25T13:15:00+08:00');
  assert.equal(event.appointment.services[0].serviceName, 'Ladies’ Curly Haircut & Curl-Defining Treatment');
  assert.equal(event.appointment.services[0].staffName, 'Phoeve Lim');
  assert.equal(event.appointment.locationName, 'Hera Hair Beauty @Tanglin Mall');
  assert.equal(event.appointment.totalPrice, 205);
  assert.deepEqual(event.warnings, []);
});

test('classifies exact observed highlights service', async () => {
  const body = await fixture('confirmed-highlights.txt');
  const event = parseTimelyEmail({ subject: 'Appointment confirmed for Test Highlights on Fri, 21 Aug 2026 4:00PM', body });
  const classified = classifyAppointment(event.appointment.services.map((s) => s.serviceName));
  assert.equal(classified.preconsultRequired, true);
  assert.equal(classified.classifications[0].category, 'HIGHLIGHTS');
  assert.equal(classified.classifications[0].confidence, 'EXACT');
});

test('classifies observed non-bleach balayage', async () => {
  const body = await fixture('confirmed-nonbleach-balayage.txt');
  const event = parseTimelyEmail({ subject: 'Appointment confirmed for Test Balayage on Sat, 29 Aug 2026 12:00PM', body });
  const classified = classifyAppointment(event.appointment.services.map((s) => s.serviceName));
  assert.equal(classified.preconsultRequired, true);
  assert.equal(classified.classifications[0].category, 'BALAYAGE');
});

test('parses changed appointment and old appointment time', async () => {
  const body = await fixture('changed-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment changed for Test Change on Tue, 18 Aug 2026 12:45PM', body });
  assert.equal(event.eventType, 'CHANGED');
  assert.equal(event.appointment.localIso, '2026-08-18T12:45:00+08:00');
  assert.equal(event.appointment.previousLocalIso, '2026-08-25T13:30:00+08:00');
  assert.equal(event.source.bookingOrigin, 'ONLINE');
  assert.equal(event.source.changedBy, 'Test Change');
  assert.ok(previousBookingFingerprint(event));
});

test('parses cancellation and cancellation reason', async () => {
  const body = await fixture('cancelled-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment cancelled for Test Cancel on Sat, 5 Sep 2026 3:00PM', body });
  assert.equal(event.eventType, 'CANCELLED');
  assert.equal(event.appointment.cancellationReason, 'Reschedule to another day');
  assert.equal(event.appointment.services[0].staffName, 'Irene Lai');
});

test('fingerprint is deterministic', async () => {
  const body = await fixture('confirmed-curly.txt');
  const one = parseTimelyEmail({ subject: 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM', body });
  const two = parseTimelyEmail({ subject: 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM', body });
  assert.equal(bookingFingerprint(one), bookingFingerprint(two));
});

test('unknown service fails closed to manual review', () => {
  const classified = classifyAppointment(['Experimental Curly Texture Service That Does Not Exist']);
  assert.equal(classified.preconsultRequired, false);
  assert.equal(classified.classifications[0].category, 'MANUAL_REVIEW');
  assert.equal(classified.classifications[0].confidence, 'UNKNOWN');
});


test('obvious non-target service is excluded rather than manual review', () => {
  const classified = classifyAppointment(['Express Manicure']);
  assert.equal(classified.preconsultRequired, false);
  assert.equal(classified.classifications[0].category, 'EXCLUDED');
  assert.equal(classified.classifications[0].confidence, 'RULE');
});

test('parses customer-facing Timely V2 curly confirmation with date-only line', async () => {
  const body = await fixture('customer-confirmed-curly.txt');
  const event = parseTimelyEmail({
    subject: 'Your appointment booking on Thu, 20 Aug 2026 4:00PM is confirmed',
    body,
    gmailMessageId: 'v2-confirm',
  });
  assert.equal(event.parserVersion, 'TIMELY_EMAIL_V2');
  assert.equal(event.eventType, 'CONFIRMED');
  assert.equal(event.appointment.localIso, '2026-08-20T16:00:00+08:00');
  assert.equal(event.appointment.services[0].serviceName, 'Ladies’ Curly Haircut & Styling');
  assert.equal(event.customer.name, 'Example Client');
  assert.equal(event.customer.mobile, '+6591111111');
  assert.equal(event.customer.timelyCustomerId, undefined);
  assert.equal(event.source.timelyBookingId, '11111111-1111-4111-8111-111111111111');
  assert.equal(event.source.emailFormat, 'CUSTOMER_NOTIFICATION');
  assert.equal(event.appointment.totalPrice, undefined);
  assert.deepEqual(event.warnings, []);
});

test('parses and classifies customer-facing V2 balayage confirmation', async () => {
  const body = await fixture('customer-confirmed-balayage.txt');
  const event = parseTimelyEmail({ subject: 'Your appointment booking on Sat, 29 Aug 2026 3:00PM is confirmed', body });
  const classified = classifyAppointment(event.appointment.services.map((s) => s.serviceName));
  assert.equal(event.appointment.localIso, '2026-08-29T15:00:00+08:00');
  assert.equal(classified.preconsultRequired, true);
  assert.equal(classified.classifications[0].category, 'BALAYAGE');
});

test('parses customer-facing V2 changed event without old time when stable booking id exists', async () => {
  const body = await fixture('customer-changed-curly.txt');
  const event = parseTimelyEmail({ subject: 'Your appointment with Hera Hair Beauty has changed', body });
  assert.equal(event.eventType, 'CHANGED');
  assert.equal(event.appointment.localIso, '2026-08-21T14:30:00+08:00');
  assert.equal(event.appointment.previousLocalIso, undefined);
  assert.equal(event.source.timelyBookingId, '11111111-1111-4111-8111-111111111111');
  assert.ok(!event.warnings.includes('PREVIOUS_APPOINTMENT_TIME_NOT_FOUND'));
});

test('parses customer-facing V2 cancellation even when Timely omits booking change link', async () => {
  const body = await fixture('customer-cancelled-curly.txt');
  const event = parseTimelyEmail({ subject: 'Your appointment booking on Fri, 21 Aug 2026 2:30PM has been cancelled', body });
  assert.equal(event.eventType, 'CANCELLED');
  assert.equal(event.appointment.localIso, '2026-08-21T14:30:00+08:00');
  assert.equal(event.source.timelyBookingId, undefined);
  assert.equal(event.customer.email, 'example-client@example.com');
});

test('hard-excludes broader root/regrowth and toner variants', () => {
  for (const service of ['Root Tint (Medium)', 'Regrowth Tint + Styling', 'Regrowth Colour', 'Toner treatment']) {
    const classified = classifyAppointment([service]);
    assert.equal(classified.preconsultRequired, false, service);
    assert.equal(classified.classifications[0].category, 'EXCLUDED', service);
  }
});

test('toner add-on does not incorrectly exclude a qualifying colour service', () => {
  const classified = classifyAppointment(['FULL Colour + Toner + Wash & Styling']);
  assert.equal(classified.preconsultRequired, true);
  assert.equal(classified.classifications[0].category, 'COLOUR');
});
