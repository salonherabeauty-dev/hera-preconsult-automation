import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function app() {
  return readFile(new URL('../public/app.js', import.meta.url), 'utf8');
}

test('dashboard uses 48 hours as escalation priority while earlier pre-consult remains available', async () => {
  const source = await app();
  assert.match(source, /const CONTACT_HOURS = 48/);
  assert.match(source, /\['contact', 'Contact priority'\]/);
  assert.match(source, /\['upcoming', 'Upcoming'\]/);
  assert.match(source, /Pre-consult available/);
  assert.match(source, /available for proactive contact at any time/);
  assert.doesNotMatch(source, /do not contact yet/i);
  assert.doesNotMatch(source, /Nothing needs to be sent yet/i);
  assert.doesNotMatch(source, /h <= 60/);
});

test('dashboard preserves approved maintenance opt-out wording', async () => {
  const source = await app();
  assert.match(source, /If you’re simply maintaining your usual look with us, there’s nothing further you need to send 😊/);
  assert.match(source, /If you’re simply maintaining your usual curly look with us, there’s nothing further you need to send 😊/);
});

test('dashboard has booked-date intelligence and safe repair control', async () => {
  const source = await app();
  assert.match(source, /Originally booked/);
  assert.match(source, /Booking lead time/);
  assert.match(source, /lookbackHours:72/);
  assert.match(source, /No WhatsApp is sent by repair/);
});

test('dashboard auto-refreshes data and performs foreground Gmail scans without auto messaging', async () => {
  const source = await app();
  assert.match(source, /AUTO_REFRESH_MS = 60_000/);
  assert.match(source, /AUTO_GMAIL_SYNC_MS = 5 \* 60_000/);
  assert.match(source, /autoSyncIfDue/);
  assert.doesNotMatch(source, /followups\.length/);
});


test('dashboard operational workflow buckets are mutually exclusive', async () => {
  const source = await app();
  assert.match(source, /function workflowBucket\(b\)/);
  assert.match(source, /p\.current_photos_received \|\| p\.workflow_status === 'photos_received'/);
  assert.match(source, /if \(p\.whatsapp_sent_at\) return 'waiting'/);
  assert.match(source, /return bucket === tab/);
});

test('New 24h is a clickable dedicated view and KPI', async () => {
  const source = await app();
  assert.match(source, /\['new', 'New · 24h'\]/);
  assert.match(source, /if \(tab === 'new'\) return hoursUntil\(b\) > 0 && isNewBooking\(b\)/);
  assert.match(source, /data-kpi-tab="\$\{tab\}"/);
  assert.match(source, /Click to review recent bookings/);
});
