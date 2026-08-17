export interface DashboardSupabaseConfig {
  url: string;
  secretKey: string;
}

type Json = Record<string, unknown>;

export async function dashboardSupabaseFetch<T>(
  config: DashboardSupabaseConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.secretKey,
      ...(config.secretKey.startsWith('eyJ') ? { Authorization: `Bearer ${config.secretKey}` } : {}),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DASHBOARD_SUPABASE_${response.status}:${text.slice(0, 500)}`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function dashboardSupabaseConfig(env: Record<string, string | undefined>): DashboardSupabaseConfig {
  const url = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!url) throw new Error('MISSING_ENV:SUPABASE_URL');
  if (!secretKey) throw new Error('MISSING_ENV:SUPABASE_SECRET_KEY');
  return { url, secretKey };
}

export async function appendDashboardAudit(
  config: DashboardSupabaseConfig,
  bookingId: string,
  action: string,
  details: Json = {},
): Promise<void> {
  await dashboardSupabaseFetch(config, 'audit_logs', {
    method: 'POST',
    body: JSON.stringify({
      booking_id: bookingId,
      action,
      actor_type: 'staff',
      actor_name: 'Hera Preconsult Dashboard',
      details,
    }),
  });
}
