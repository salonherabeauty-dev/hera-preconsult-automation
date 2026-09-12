import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { protectClient, protectWorkflow } from '../scripts/enforce-contact-review.mjs';

const client = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../api/workflow.ts', import.meta.url), 'utf8');
const openSource = client.match(/  async function openWhatsapp\(b, text\) \{[\s\S]*?(?=\n  async function workflow)/)?.[0];
const bucketSource = client.match(/  function workflowBucket\(b\) \{[\s\S]*?(?=\n  function tabMatch)/)?.[0];
function booking(overrides = {}) { return { id: 'synthetic-test', appointment_at: '2099-01-01T10:00:00Z', last_timely_event_at: '2098-01-01T00:00:00Z', booking_status: 'confirmed', client_mobile: '+6590000000', preconsult_status: { required: true, workflow_status: 'to_contact' }, ...overrides }; }
function harness(fresh, failure = false) {
  let opened = 0, closed = 0, refreshes = 0;
  const target = { location: { href: '' }, close() { closed++; } };
  const notices = [];
  const context = {
    isContactHeld: b => b?.preconsult_status?.workflow_status === 'manual_review',
    isCancelled: b => b.booking_status === 'cancelled' || b.preconsult_status?.workflow_status === 'blocked_cancelled',
    isPassed: b => new Date(b.appointment_at).getTime() < Date.now(),
    hoursUntil: () => 24,
    toast: text => notices.push(text),
    window: { open: () => { opened++; return target; } },
    api: async () => { if (failure) throw new Error('synthetic provider failure'); return { bookings: fresh ? [fresh] : [] }; },
    loadData: async () => { refreshes++; },
    whatsappMobile: b => b.client_mobile,
    validWhatsapp: value => /^\+[1-9]\d{7,14}$/.test(value),
    waPhone: value => value.replace(/\D/g, ''),
    console: { warn() {} },
  };
  vm.createContext(context);
  vm.runInContext(`${openSource}\n${bucketSource}\nthis.send = openWhatsapp; this.bucket = workflowBucket;`, context);
  return { context, target, notices, counts: () => ({ opened, closed, refreshes }) };
}
test('prebuild contact safeguards are actually present in deployment sources', () => {
  assert.ok(client.startsWith('// HERA_CONTACT_REVIEW_GUARD_V2'));
  assert.ok(server.startsWith('// HERA_CONTACT_REVIEW_GUARD_V2'));
  assert.ok(openSource); assert.ok(bucketSource);
  assert.ok(client.includes("['review', 'Needs Review']"));
  new vm.Script(client);
});
test('contact transforms are idempotent', () => { assert.equal(protectClient(client), client); assert.equal(protectWorkflow(server), server); });
test('changed upstream source fails build closed', () => { assert.throws(() => protectClient('unknown-source'), /CONTACT_GUARD_SOURCE_CHANGED/); assert.throws(() => protectWorkflow('unknown-source'), /CONTACT_GUARD_SOURCE_CHANGED/); });
test('held booking is in review, never To Contact', () => { const h = harness(booking()); assert.equal(h.context.bucket(booking({ preconsult_status: { required: true, workflow_status: 'manual_review' } })), 'review'); assert.equal(h.context.bucket(booking()), 'contact'); });
test('held local booking cannot open even a WhatsApp placeholder', async () => { const h = harness(booking()); await h.context.send(booking({ preconsult_status: { required: true, workflow_status: 'manual_review' } }), 'test draft'); assert.equal(h.counts().opened, 0); });
test('fresh cancellation prevents opening WhatsApp from a stale drawer', async () => { const h = harness(booking({ booking_status: 'cancelled' })); await h.context.send(booking(), 'test draft'); assert.equal(h.counts().closed, 1); assert.equal(h.target.location.href, ''); });
test('fresh contact hold prevents opening WhatsApp', async () => { const h = harness(booking({ preconsult_status: { required: true, workflow_status: 'manual_review' } })); await h.context.send(booking(), 'test draft'); assert.equal(h.counts().closed, 1); assert.equal(h.target.location.href, ''); });
test('failed live recheck blocks WhatsApp instead of trusting cached state', async () => { const h = harness(booking(), true); await h.context.send(booking(), 'test draft'); assert.equal(h.counts().closed, 1); assert.equal(h.target.location.href, ''); });
test('changed appointment requires review of updated draft', async () => { const h = harness(booking({ appointment_at: '2099-01-01T11:00:00Z' })); await h.context.send(booking(), 'test draft'); assert.equal(h.counts().closed, 1); assert.equal(h.target.location.href, ''); });
test('eligible unchanged booking opens only a draft after successful recheck', async () => { const h = harness(booking()); await h.context.send(booking(), 'test draft'); assert.equal(h.target.location.href, 'https://wa.me/6590000000?text=test%20draft'); assert.equal(h.counts().closed, 0); });
test('server rejects mutating a held workflow but allows staff notes', () => {
  const guard = server.match(/    if \(status\.workflow_status === 'manual_review'[\s\S]*?\n    \}/)?.[0];
  assert.ok(guard);
  const evaluate = new Function('status', 'body', 'Response', `${guard}\nreturn null;`);
  const response = { json: (payload, options) => ({ payload, options }) };
  assert.equal(evaluate({ workflow_status: 'manual_review' }, { action: 'mark_sent' }, response).options.status, 409);
  assert.equal(evaluate({ workflow_status: 'manual_review' }, { action: 'reopen' }, response).options.status, 409);
  assert.equal(evaluate({ workflow_status: 'manual_review' }, { action: 'save_notes' }, response), null);
});
