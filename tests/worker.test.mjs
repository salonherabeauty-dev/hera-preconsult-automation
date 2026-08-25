import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { processLifecycleMessage } from '../dist/worker.js';

async function fixture(name) {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

class MemoryRepo {
  events = new Map();
  bookings = [];
  alerts = [];
  applied = undefined;
  async getEventState(id) { const e = this.events.get(id); return { exists: !!e, processed: !!e?.processed }; }
  async startEvent({ message }) { this.events.set(message.id, { processed: false }); }
  async listCandidateBookings() { return this.bookings; }
  async applyPlan(input) {
    this.applied = input;
    if (input.plan.action === 'CREATE') return { bookingId: 'b-new', outcome: input.plan.reason };
    if ('bookingId' in input.plan) return { bookingId: input.plan.bookingId, outcome: input.plan.reason };
    throw new Error('unexpected plan');
  }
  async finishEvent({ gmailMessageId, parseStatus, identityResolution }) {
    this.events.set(gmailMessageId, { processed: true, parseStatus, identityResolution });
  }
  async createAlert(alert) { this.alerts.push(alert); }
}

test('worker processes qualifying curly confirmation', async () => {
  const repo = new MemoryRepo();
  const result = await processLifecycleMessage({
    id: 'm-curly',
    subject: 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM',
    body: await fixture('confirmed-curly.txt'),
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'PROCESSED');
  assert.equal(result.bookingId, 'b-new');
});

test('worker ignores obvious non-target service without alert flood', async () => {
  const repo = new MemoryRepo();
  const body = (await fixture('confirmed-curly.txt')).replace('Ladies’ Curly Haircut & Curl-Defining Treatment', 'Express Manicure');
  const result = await processLifecycleMessage({
    id: 'm-nail',
    subject: 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM',
    body,
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'IGNORED');
  assert.equal(repo.alerts.length, 0);
});

test('worker sends unknown target-domain service to manual review', async () => {
  const repo = new MemoryRepo();
  const body = (await fixture('confirmed-curly.txt')).replace('Ladies’ Curly Haircut & Curl-Defining Treatment', 'Experimental Curly Texture Transformation');
  const result = await processLifecycleMessage({
    id: 'm-review',
    subject: 'Appointment confirmed for Test Curly on Tue, 25 Aug 2026 1:15PM',
    body,
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'MANUAL_REVIEW');
  assert.equal(repo.alerts[0].alertType, 'unknown_target_service');
});

test('worker processes qualifying multi-service booking despite unknown add-on and raises review alert', async () => {
  const repo = new MemoryRepo();
  const body = (await fixture('confirmed-curly.txt')).replace(
    'Ladies’ Curly Haircut & Curl-Defining Treatment with Phoeve Lim at 1:15PM',
    'FULL Head Highlights + Wash & Styling (Long) with Phoeve Lim at 1:15PM\n\nKeratin Bond Extension Experimental Add On with Phoeve Lim at 4:15PM',
  );
  const result = await processLifecycleMessage({
    id: 'm-mixed',
    subject: 'Appointment confirmed for Mixed Client on Tue, 25 Aug 2026 1:15PM',
    body,
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'PROCESSED');
  assert.equal(repo.alerts[0].alertType, 'unknown_service_in_qualifying_booking');
});

test('worker ignores changed children haircut with no tracked target booking', async () => {
  const repo = new MemoryRepo();
  const body = (await fixture('changed-curly.txt'))
    .replace('Ladies’ Curly Haircut & Styling (XL)', "Kid’s girl Haircut (below 10yrs)");
  const result = await processLifecycleMessage({
    id: 'm-kids-change',
    subject: 'Appointment changed for Test Change on Tue, 18 Aug 2026 12:45PM',
    body,
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'IGNORED');
  assert.equal(result.outcome, 'Non-target Timely service.');
  assert.equal(repo.alerts.length, 0);
});

test('worker hard-excludes approved exact root colour service', async () => {
  const repo = new MemoryRepo();
  const body = (await fixture('confirmed-curly.txt')).replace('Ladies’ Curly Haircut & Curl-Defining Treatment', 'ROOT Colour+Wash & Styling (Medium)');
  const result = await processLifecycleMessage({
    id: 'm-root-colour',
    subject: 'Appointment confirmed for Root Client on Tue, 25 Aug 2026 1:15PM',
    body,
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'IGNORED');
  assert.equal(repo.alerts.length, 0);
});

test('worker sends unseen root colour variant to policy review', async () => {
  const repo = new MemoryRepo();
  const body = (await fixture('confirmed-curly.txt')).replace('Ladies’ Curly Haircut & Curl-Defining Treatment', 'ROOT Colour+Wash & Styling (Long)');
  const result = await processLifecycleMessage({
    id: 'm-root-long',
    subject: 'Appointment confirmed for Root Client on Tue, 25 Aug 2026 1:15PM',
    body,
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'MANUAL_REVIEW');
});

test('worker hard-excludes approved toner-only service', async () => {
  const repo = new MemoryRepo();
  const body = (await fixture('confirmed-curly.txt')).replace('Ladies’ Curly Haircut & Curl-Defining Treatment', 'Toning Alone treatment');
  const result = await processLifecycleMessage({
    id: 'm-toner',
    subject: 'Appointment confirmed for Toner Client on Tue, 25 Aug 2026 1:15PM',
    body,
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'IGNORED');
  assert.equal(repo.alerts.length, 0);
});

test('worker processes customer-facing V2 qualifying confirmation', async () => {
  const repo = new MemoryRepo();
  const result = await processLifecycleMessage({
    id: 'm-v2-curly',
    subject: 'Your appointment booking on Thu, 20 Aug 2026 4:00PM is confirmed',
    body: await fixture('customer-confirmed-curly.txt'),
    receivedAt: '2026-08-17T15:55:56.000Z',
  }, repo, new Date('2026-08-18T00:00:00.000Z'));
  assert.equal(result.status, 'PROCESSED');
  assert.equal(result.bookingId, 'b-new');
});

test('worker removes tracked qualifying booking from scope when service changes to exact root exclusion', async () => {
  const repo = new MemoryRepo();
  repo.bookings = [{
    id: 'tracked-qualifying',
    timelyCustomerId: '10000004',
    appointmentLocalIso: '2026-08-25T13:30:00+08:00',
    locationName: 'Hera Hair Beauty @Sentosa Cove',
    serviceNames: ['Ladies’ Curly Haircut & Styling (XL)'],
    status: 'CONFIRMED',
  }];
  const body = (await fixture('changed-curly.txt'))
    .replace('Ladies’ Curly Haircut & Styling (XL)', 'ROOT Colour+Wash & Styling (Medium)');
  const result = await processLifecycleMessage({
    id: 'm-qualifying-to-root',
    subject: 'Appointment changed for Test Change on Tue, 18 Aug 2026 12:45PM',
    body,
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'PROCESSED');
  assert.equal(repo.applied.plan.action, 'UPDATE');
  assert.equal(repo.applied.plan.bookingId, 'tracked-qualifying');
  assert.equal(repo.applied.classifications[0].category, 'EXCLUDED');
});

test('changed event without stable identity and no parent fails closed', async () => {
  const repo = new MemoryRepo();
  const result = await processLifecycleMessage({
    id: 'm-enter-scope-no-id',
    subject: 'Appointment changed for Test Change on Tue, 18 Aug 2026 12:45PM',
    body: await fixture('changed-curly.txt'),
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'MANUAL_REVIEW');
});

test('changed event with verified change token can recover missing future parent', async () => {
  const repo = new MemoryRepo();
  const result = await processLifecycleMessage({
    id: 'm-enter-scope-stable',
    subject: 'Your appointment with Hera Hair Beauty has changed',
    body: await fixture('customer-changed-curly.txt'),
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'PROCESSED');
  assert.equal(result.bookingId, 'b-new');
  assert.match(result.outcome, /RECOVERED_FROM_VERIFIED_CHANGED_EVENT/);
});

test('older lifecycle event is applied as NOOP', async () => {
  const repo = new MemoryRepo();
  repo.bookings = [{
    id: 'newer-state',
    timelyChangeToken: '11111111-1111-4111-8111-111111111111',
    email: 'example-client@example.com',
    mobile: '+6591111111',
    appointmentLocalIso: '2026-08-21T14:30:00+08:00',
    locationName: 'Hera Hair Beauty @Tanglin Mall',
    serviceNames: ['Ladies’ Curly Haircut & Styling'],
    lastTimelyEventAt: '2026-08-18T03:00:00.000Z',
    status: 'CONFIRMED',
  }];
  const result = await processLifecycleMessage({
    id: 'm-stale',
    subject: 'Your appointment with Hera Hair Beauty has changed',
    body: await fixture('customer-changed-curly.txt'),
    receivedAt: '2026-08-17T02:00:00.000Z',
  }, repo, new Date('2026-08-17T02:00:00.000Z'));
  assert.equal(result.status, 'PROCESSED');
  assert.equal(repo.applied.plan.action, 'NOOP');
  assert.match(repo.applied.plan.reason, /EVENT_OUT_OF_ORDER/);
});
