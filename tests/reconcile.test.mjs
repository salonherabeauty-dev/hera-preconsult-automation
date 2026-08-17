import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTimelyEmail, planReconciliation, timelyGmailQueryWithLookback } from '../dist/index.js';

async function fixture(name) {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

test('changed event deterministically updates booking using Timely old time', async () => {
  const body = await fixture('changed-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment changed for Test Change on Tue, 18 Aug 2026 12:45PM', body });
  const plan = planReconciliation(event, [{
    id: 'booking-1',
    timelyCustomerId: '10000004',
    appointmentLocalIso: '2026-08-25T13:30:00+08:00',
    serviceNames: ['Ladies’ Curly Haircut & Styling (XL)'],
    status: 'CONFIRMED'
  }]);
  assert.deepEqual(plan, {
    action: 'UPDATE',
    bookingId: 'booking-1',
    reason: 'Matched Timely previous appointment time from Recent activity.'
  });
});

test('cancellation deterministically cancels exact booking', async () => {
  const body = await fixture('cancelled-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment cancelled for Test Cancel on Sat, 5 Sep 2026 3:00PM', body });
  const plan = planReconciliation(event, [{
    id: 'booking-2',
    timelyCustomerId: '10000005',
    appointmentLocalIso: '2026-09-05T15:00:00+08:00',
    serviceNames: ['Ladies’ Curly Haircut & Curl-Defining Treatment (XL)'],
    status: 'CONFIRMED'
  }]);
  assert.equal(plan.action, 'CANCEL');
  assert.equal(plan.bookingId, 'booking-2');
});

test('ambiguous change fails closed', async () => {
  const body = await fixture('changed-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment changed for Test Change on Tue, 18 Aug 2026 12:45PM', body });
  const duplicate = {
    timelyCustomerId: '10000004',
    appointmentLocalIso: '2026-08-25T13:30:00+08:00',
    serviceNames: ['Ladies’ Curly Haircut & Styling (XL)'],
    status: 'CONFIRMED'
  };
  const plan = planReconciliation(event, [
    { id: 'a', ...duplicate },
    { id: 'b', ...duplicate }
  ]);
  assert.equal(plan.action, 'NEEDS_REVIEW');
});

test('Gmail discovery query is subject-agnostic so Timely format changes are not missed', () => {
  const query = timelyGmailQueryWithLookback(2);
  assert.match(query, /from:noreply@gettimely\.com/);
  assert.match(query, /-subject:"day sheet"/);
  assert.doesNotMatch(query, /subject:"Appointment confirmed"/);
  assert.match(query, /newer_than:2d/);
});

test('reconciliation matches same appointment instant even when DB returns UTC', async () => {
  const body = await fixture('confirmed-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM', body });
  const plan = planReconciliation(event, [{
    id: 'utc-1',
    timelyCustomerId: event.customer.timelyCustomerId,
    appointmentLocalIso: '2026-08-25T05:15:00.000Z',
    serviceNames: event.appointment.services.map((s) => s.serviceName),
    status: 'CONFIRMED',
  }]);
  assert.equal(plan.action, 'NOOP');
});

test('stable Timely booking reference is highest-confidence match for changed V2 email', async () => {
  const body = await fixture('customer-changed-curly.txt');
  const event = parseTimelyEmail({ subject: 'Your appointment with Hera Hair Beauty has changed', body });
  const plan = planReconciliation(event, [{
    id: 'stable-1',
    timelyBookingId: '11111111-1111-4111-8111-111111111111',
    email: 'example-client@example.com',
    mobile: '+6591111111',
    appointmentLocalIso: '2026-08-20T16:00:00+08:00',
    serviceNames: ['Ladies’ Curly Haircut & Styling'],
    status: 'CONFIRMED',
  }]);
  assert.deepEqual(plan, { action: 'UPDATE', bookingId: 'stable-1', reason: 'Matched stable Timely booking reference.' });
});

test('customer-facing cancellation falls back deterministically to customer + appointment time', async () => {
  const body = await fixture('customer-cancelled-curly.txt');
  const event = parseTimelyEmail({ subject: 'Your appointment booking on Fri, 21 Aug 2026 2:30PM has been cancelled', body });
  const plan = planReconciliation(event, [{
    id: 'cancel-v2',
    email: 'example-client@example.com',
    mobile: '+6591111111',
    appointmentLocalIso: '2026-08-21T06:30:00.000Z',
    serviceNames: ['Ladies’ Curly Haircut & Styling'],
    status: 'CONFIRMED',
  }]);
  assert.equal(plan.action, 'CANCEL');
  assert.equal(plan.bookingId, 'cancel-v2');
});

test('duplicate cancellation is idempotent instead of manual review', async () => {
  const body = await fixture('cancelled-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment cancelled for Test Cancel on Sat, 5 Sep 2026 3:00PM', body });
  const plan = planReconciliation(event, [{
    id: 'cancelled-1',
    timelyCustomerId: '10000005',
    appointmentLocalIso: '2026-09-05T15:00:00+08:00',
    serviceNames: ['Ladies’ Curly Haircut & Curl-Defining Treatment (XL)'],
    status: 'CANCELLED',
  }]);
  assert.deepEqual(plan, {
    action: 'NOOP',
    bookingId: 'cancelled-1',
    reason: 'Matching booking is already cancelled.',
  });
});

test('confirmation never silently matches a cancelled booking', async () => {
  const body = await fixture('confirmed-curly.txt');
  const event = parseTimelyEmail({ subject: 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM', body });
  const plan = planReconciliation(event, [{
    id: 'cancelled-confirm',
    timelyCustomerId: '10000001',
    appointmentLocalIso: '2026-08-25T13:15:00+08:00',
    serviceNames: ['Ladies’ Curly Haircut & Curl-Defining Treatment'],
    status: 'CANCELLED',
  }]);
  assert.equal(plan.action, 'NEEDS_REVIEW');
});

test('changed event matches same customer and appointment time when the service set changed completely', async () => {
  const body = (await fixture('customer-changed-curly.txt')).replace('Ladies’ Curly Haircut & Styling', 'ROOT Colour+Wash & Styling (Medium)');
  const event = parseTimelyEmail({ subject: 'Your appointment with Hera Hair Beauty has changed', body });
  // Remove stable reference to exercise the deterministic customer+time fallback.
  event.source.timelyBookingId = undefined;
  const plan = planReconciliation(event, [{
    id: 'same-time-old-service',
    email: event.customer.email,
    mobile: event.customer.mobile,
    appointmentLocalIso: event.appointment.localIso,
    serviceNames: ['FULL Colour+Wash & Styling (Long)'],
    status: 'CONFIRMED',
  }]);
  assert.equal(plan.action, 'UPDATE');
  assert.equal(plan.bookingId, 'same-time-old-service');
  assert.match(plan.reason, /same active customer \+ appointment time/i);
});
