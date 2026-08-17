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
  async getEventState(id) { const e = this.events.get(id); return { exists: !!e, processed: !!e?.processed }; }
  async startEvent({ message }) { this.events.set(message.id, { processed: false }); }
  async listCandidateBookings() { return this.bookings; }
  async applyPlan({ plan }) {
    if (plan.action === 'CREATE') return { bookingId: 'b-new', outcome: plan.reason };
    if ('bookingId' in plan) return { bookingId: plan.bookingId, outcome: plan.reason };
    throw new Error('unexpected plan');
  }
  async finishEvent({ gmailMessageId, parseStatus }) { this.events.set(gmailMessageId, { processed: true, parseStatus }); }
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
  assert.equal(repo.events.get('m-kids-change')?.parseStatus, 'ignored');
});

test('worker hard-excludes root colour from pre-consult workflow', async () => {
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

test('worker hard-excludes toner-only service from pre-consult workflow', async () => {
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
