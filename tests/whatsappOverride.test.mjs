import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('dashboard exposes a safe WhatsApp override without replacing Timely mobile', async () => {
  const source = await read('api/dashboard.ts');
  assert.match(source, /client_mobile/);
  assert.match(source, /whatsapp_mobile_override/);
  assert.match(source, /whatsapp_mobile_override_updated_at/);
});

test('workflow validates E.164 and audits set/reset override actions', async () => {
  const source = await read('api/workflow.ts');
  assert.match(source, /const E164/);
  assert.match(source, /\\d\{7,14\}/);
  assert.match(source, /set_whatsapp_override/);
  assert.match(source, /reset_whatsapp_override/);
  assert.match(source, /preconsult_whatsapp_mobile_override_set/);
  assert.match(source, /preconsult_whatsapp_mobile_override_reset/);
  assert.match(source, /Do not guess the country code/);
});

test('front desk UI clearly separates Timely number from verified WhatsApp number', async () => {
  const source = await read('public/app.js');
  assert.match(source, /WhatsApp number/);
  assert.match(source, /Timely number/);
  assert.match(source, /WhatsApp used/);
  assert.match(source, /Verified WhatsApp number/);
  assert.match(source, /does not edit the client\'s Timely record/);
  assert.match(source, /whatsappMobile\(b\)/);
});

test('migration constrains overrides to international E.164 format', async () => {
  const source = await read('supabase/migrations/20260818_whatsapp_mobile_override.sql');
  assert.match(source, /whatsapp_mobile_override text/);
  assert.match(source, /preconsult_status_whatsapp_override_e164/);
});
