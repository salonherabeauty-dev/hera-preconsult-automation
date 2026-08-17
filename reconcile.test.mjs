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

test('Gmail query targets only Timely appointment lifecycle messages', () => {
  const query = timelyGmailQueryWithLookback(2);
  assert.match(query, /from:noreply@gettimely\.com/);
  assert.match(query, /Appointment confirmed/);
  assert.match(query, /Appointment changed/);
  assert.match(query, /Appointment cancelled/);
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
