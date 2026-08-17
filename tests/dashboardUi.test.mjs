import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function app() {
  return readFile(new URL('../public/app.js', import.meta.url), 'utf8');
}

test('dashboard separates workflow from time intelligence with explicit 24h booking and 48h appointment meanings', async () => {
  const source = await app();
  assert.match(source, /const CONTACT_HOURS = 48/);
  assert.match(source, /const NEW_BOOKING_HOURS = 24/);
  assert.match(source, /\['contact', 'To Contact'\]/);
  assert.match(source, /\['waiting', 'Sent'\]/);
  assert.match(source, /\['photos', 'Photos Received'\]/);
  assert.doesNotMatch(source, /\['upcoming', 'Upcoming'\]/);
  assert.doesNotMatch(source, /\['new', 'New · 24h'\]/);
  assert.match(source, /Due Soon · ≤48h/);
  assert.match(source, /Unsent appointments within 48h/);
  assert.match(source, /New Bookings · ≤24h/);
  assert.match(source, /Booked within the last 24h/);
  assert.doesNotMatch(source, /do not contact yet/i);
  assert.doesNotMatch(source, /Nothing needs to be sent yet/i);
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


test('dashboard operational workflow buckets are mutually exclusive and every unsent future client is To Contact', async () => {
  const source = await app();
  assert.match(source, /function workflowBucket\(b\)/);
  assert.match(source, /p\.current_photos_received \|\| p\.workflow_status === 'photos_received'/);
  assert.match(source, /if \(p\.whatsapp_sent_at\) return 'waiting'/);
  assert.match(source, /if \(h <= 0\) return 'expired'/);
  assert.match(source, /return 'contact'/);
  assert.match(source, /return bucket === tab/);
  assert.doesNotMatch(source, /return 'upcoming'/);
});

test('New bookings and Due Soon are clickable intelligence filters, not workflow stages', async () => {
  const source = await app();
  assert.match(source, /intelFilter: null/);
  assert.match(source, /state\.intelFilter === 'new'/);
  assert.match(source, /state\.intelFilter === 'due'/);
  assert.match(source, /data-kpi-intel="\$\{intel\}"/);
  assert.match(source, /NEW · BOOKED ≤24H/);
  assert.match(source, /Due soon · appt ≤48h/);
  assert.match(source, /booked within 24h/);
  assert.match(source, /appointment within 48h/);
});

