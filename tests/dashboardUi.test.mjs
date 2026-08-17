import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function app() {
  return readFile(new URL('../public/app.js', import.meta.url), 'utf8');
}

test('dashboard uses exact 48-hour contact boundary and separate upcoming queue', async () => {
  const source = await app();
  assert.match(source, /const CONTACT_HOURS = 48/);
  assert.match(source, /\['contact', 'Contact now'\]/);
  assert.match(source, /\['upcoming', 'Upcoming'\]/);
  assert.doesNotMatch(source, /h <= 60/);
  assert.match(source, /tabMatch\(b,'contact'\)/);
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
