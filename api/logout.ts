import { clearSessionCookie } from '../src/dashboardAuth.js';

export async function POST(): Promise<Response> {
  return Response.json(
    { ok: true },
    { headers: { 'Set-Cookie': clearSessionCookie(), 'Cache-Control': 'no-store' } },
  );
}
