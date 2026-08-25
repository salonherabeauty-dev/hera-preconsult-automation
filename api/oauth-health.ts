import { refreshGoogleAccessToken } from '../src/gmailApi.js';

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV === 'production') {
    return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return Response.json({
      ok: false,
      error: 'Preview Google OAuth environment variables are incomplete.',
      present: {
        clientId: Boolean(clientId),
        clientSecret: Boolean(clientSecret),
        refreshToken: Boolean(refreshToken),
      },
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const accessToken = await refreshGoogleAccessToken({ clientId, clientSecret, refreshToken });
    const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await profileResponse.text();
    if (!profileResponse.ok) {
      return Response.json({
        ok: false,
        error: `GMAIL_PROFILE_${profileResponse.status}`,
        detail: text.slice(0, 300),
      }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    const profile = JSON.parse(text) as { emailAddress?: string };
    return Response.json({
      ok: profile.emailAddress === 'salonherabeauty@gmail.com',
      emailAddress: profile.emailAddress,
      scope: 'gmail.readonly',
      environment: process.env.VERCEL_ENV,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message.slice(0, 500) }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
