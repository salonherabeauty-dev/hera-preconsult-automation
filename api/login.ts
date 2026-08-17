import { createDashboardSession, dashboardPasswordMatches, sessionCookie } from '../src/dashboardAuth.js';

export async function POST(request: Request): Promise<Response> {
  const env = process.env as Record<string, string | undefined>;
  if (!env.DASHBOARD_PASSWORD || !env.CRON_SECRET) {
    return Response.json({ ok: false, error: 'Dashboard login is not configured.' }, { status: 503 });
  }
  let body: { password?: string } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  if (!dashboardPasswordMatches(body.password, env.DASHBOARD_PASSWORD)) {
    return Response.json({ ok: false, error: 'Incorrect password.' }, { status: 401 });
  }
  const token = await createDashboardSession(env.CRON_SECRET);
  return Response.json(
    { ok: true },
    { headers: { 'Set-Cookie': sessionCookie(token), 'Cache-Control': 'no-store' } },
  );
}
