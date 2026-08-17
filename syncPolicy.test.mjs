import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSyncWindow,
  buildLifecycleQueryForWindow,
  classifyAppointmentTiming,
} from '../dist/syncPolicy.js';

test('sync window overlaps previous successful sync by 15 minutes', () => {
  const last = new Date('2026-08-16T02:00:00.000Z'); // 10:00 SGT
  const now = new Date('2026-08-17T02:00:00.000Z');
  const window = buildSyncWindow({ now, lastSuccessfulSync: last });
  assert.equal(window.from.toISOString(), '2026-08-16T01:45:00.000Z');
  assert.equal(window.to.toISOString(), '2026-08-17T02:00:00.000Z');
  assert.equal(window.source, 'last_successful_sync');
});

test('first run looks back 26 hours', () => {
  const now = new Date('2026-08-17T02:00:00.000Z');
  const window = buildSyncWindow({ now });
  assert.equal(window.from.toISOString(), '2026-08-16T00:00:00.000Z');
  assert.equal(window.source, 'initial_lookback');
});

test('lifecycle query contains Timely lifecycle filters and epoch window', () => {
  const window = {
    from: new Date('2026-08-16T01:45:00.000Z'),
    to: new Date('2026-08-17T02:00:00.000Z'),
    source: 'last_successful_sync',
  };
  const query = buildLifecycleQueryForWindow(window);
  assert.match(query, /from:noreply@gettimely\.com/);
  assert.match(query, /Appointment confirmed/);
  assert.match(query, /Appointment changed/);
  assert.match(query, /Appointment cancelled/);
  assert.match(query, /-subject:"day sheet"/);
  assert.match(query, /after:\d+/);
  assert.match(query, /before:\d+/);
});

test('appointment timing flags same-day future booking as urgent', () => {
  const now = new Date('2026-08-17T02:30:00.000Z'); // 10:30 SGT
  assert.equal(
    classifyAppointmentTiming('2026-08-17T14:00:00+08:00', now),
    'SAME_DAY_URGENT',
  );
  assert.equal(
    classifyAppointmentTiming('2026-08-18T14:00:00+08:00', now),
    'UPCOMING',
  );
  assert.equal(
    classifyAppointmentTiming('2026-08-17T09:00:00+08:00', now),
    'PAST',
  );
});
