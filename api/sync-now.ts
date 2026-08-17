import { isDashboardAuthorized } from '../src/dashboardAuth.js';
import { envConfig, runDailySync } from '../src/dailySync.js';

export async function POST(request: Request): Promise<Response> {
  const env = process.env as Record<string, string | undefined>;
  if (!(await isDashboardAuthorized(request, env))) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: { lookbackHours?: number } = {};
  try { body = await request.json(); } catch { /* empty body is a normal incremental scan */ }
  const lookbackHours = body.lookbackHours;
  if (lookbackHours != null && (!Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 168)) {
    return Response.json({ ok: false, error: 'lookbackHours must be an integer from 1 to 168.' }, { status: 400 });
  }

  try {
    const result = await runDailySync({ ...envConfig(env), forceLookbackHours: lookbackHours });
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
