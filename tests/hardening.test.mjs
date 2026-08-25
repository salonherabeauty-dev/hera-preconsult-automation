import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAppointment,
  getLifecycleMessage,
  parseTimelyEmail,
  planReconciliation,
  refreshGoogleAccessToken,
} from '../dist/index.js';

function b64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

const token = 'd3b185f6-dec2-469a-bb85-bed93665a960';
const uid = 'BG445754672';

function body({ event = 'confirmed', services = [
  'Ladies’ Curly Haircut & Styling with Phoeve at 3:00PM',
  'Curly Hair HALF Highlights (Medium) with Phoeve at 4:30PM',
] } = {}) {
  return [
    `Appointment ${event}`,
    'Hera Hair Beauty',
    'Sat, 12 Sep 2026',
    ...services,
    'At this location',
    'Hera Hair Beauty @Tanglin Mall',
    'Your details',
    'Claire Williams',
    'claire@example.com',
    'Mobile: +6591112222',
    `https://book.gettimely.com/booking/change/${token}`,
  ].join('\n');
}

function ics() {
  return [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    `DESCRIPTION:Change: https://book.gettimely.com/booking/change/${token}`,
    `UID:${uid}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

test('Gmail API downloads text/calendar attachment bodies', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/attachments/')) {
      return new Response(JSON.stringify({ data: b64url(ics()) }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: 'gmail-1',
      internalDate: String(Date.parse('2026-08-24T23:02:09Z')),
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: 'Your appointment booking is confirmed' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64url(body()) } },
          { mimeType: 'text/calendar', filename: 'Booking.ics', body: { attachmentId: 'att-1' } },
        ],
      },
    }), { status: 200 });
  };
  try {
    const message = await getLifecycleMessage('access', 'gmail-1');
    assert.deepEqual(message.calendarAttachments, [ics()]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OAuth refresh trims copied outer whitespace before calling Google', async () => {
  const originalFetch = globalThis.fetch;
  let submitted;
  globalThis.fetch = async (_url, init) => {
    submitted = new URLSearchParams(String(init?.body ?? ''));
    return new Response(JSON.stringify({ access_token: 'access-ok' }), { status: 200 });
  };
  try {
    const access = await refreshGoogleAccessToken({
      clientId: '  123.apps.googleusercontent.com\n',
      clientSecret: '\nGOCSPX-secret-value  ',
      refreshToken: '  1//refresh-value\n',
    });
    assert.equal(access, 'access-ok');
    assert.equal(submitted.get('client_id'), '123.apps.googleusercontent.com');
    assert.equal(submitted.get('client_secret'), 'GOCSPX-secret-value');
    assert.equal(submitted.get('refresh_token'), '1//refresh-value');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ICS UID and Timely change token remain separate stable identifiers', () => {
  const event = parseTimelyEmail({
    subject: 'Your appointment booking is confirmed',
    body: body(),
    calendarAttachments: [ics()],
  });
  assert.equal(event.source.timelyBookingId, uid);
  assert.equal(event.source.timelyChangeToken, token);
});

test('universal service rules tolerate spacing and cover established families', () => {
  for (const service of [
    'Super FULL  Head Highlights (Long)',
    'Partial Highlights',
    'HALF Head Balayage + Wash & Styling (Long)',
    'AirTouch (Long)',
    'Kids’ Curly Haircut & Styling (Boys — Below 10 Years)',
    'FULL Colour+Wash & Styling (X-Long)',
    'Men’s Hair Colouring (Medium)',
  ]) {
    assert.equal(classifyAppointment([service]).preconsultRequired, true, service);
  }
});

test('unseen root/toner variants fail closed instead of being silently classified', () => {
  assert.equal(classifyAppointment(['ROOT Colour+Wash & Styling (Long)']).classifications[0].category, 'MANUAL_REVIEW');
  assert.equal(classifyAppointment(['Toner (Long)']).classifications[0].category, 'MANUAL_REVIEW');
});

test('cancellation without stable identity requires ordered services and location', () => {
  const cancellationBody = body({ event: 'cancelled' }).replace(`https://book.gettimely.com/booking/change/${token}`, '');
  const event = parseTimelyEmail({ subject: 'Your appointment has been cancelled', body: cancellationBody });
  const exact = {
    id: 'booking-1',
    email: 'claire@example.com',
    mobile: '+6591112222',
    appointmentLocalIso: '2026-09-12T15:00:00+08:00',
    locationName: 'Hera Hair Beauty @Tanglin Mall',
    serviceNames: ['Ladies’ Curly Haircut & Styling', 'Curly Hair HALF Highlights (Medium)'],
    status: 'CONFIRMED',
  };
  assert.equal(planReconciliation(event, [exact]).action, 'CANCEL');
  assert.equal(planReconciliation(event, [{ ...exact, serviceNames: [...exact.serviceNames].reverse() }]).action, 'NEEDS_REVIEW');
});
