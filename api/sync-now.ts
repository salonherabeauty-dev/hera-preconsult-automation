import { isDashboardAuthorized } from '../src/dashboardAuth.js';
import { envConfig, runDailySync } from '../src/dailySync.js';

export async function POST(request: Request): Promise<Response> {
  const env = process.env as Record<string, string | undefined>;
  if (!(await isDashboardAuthorized(request, env))) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runDailySync(envConfig(env));
    const summary = result.results.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {});
    return Response.json({ ok: true, summary, window: result.window }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
