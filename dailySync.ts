import { getLifecycleMessage, listLifecycleMessageIds, refreshGoogleAccessToken, type GoogleOAuthCredentials } from './gmailApi.js';
import { SupabaseRestRepository, type SupabaseServerConfig } from './supabaseRest.js';
import { buildSyncWindow } from './syncPolicy.js';
import { processLifecycleMessage, type ProcessMessageResult } from './worker.js';

interface SyncStateRow {
  key: string;
  value: Record<string, unknown>;
}

async function supabaseStateRequest<T>(config: SupabaseServerConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.secretKey,
      ...(config.secretKey.startsWith('eyJ') ? { Authorization: `Bearer ${config.secretKey}` } : {}),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`SUPABASE_SYNC_STATE_${response.status}:${(await response.text()).slice(0, 500)}`);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function getLastSuccessfulSync(config: SupabaseServerConfig): Promise<Date | null> {
  const rows = await supabaseStateRequest<SyncStateRow[]>(config, 'sync_state?select=key,value&key=eq.gmail_last_successful_sync&limit=1');
  const iso = rows[0]?.value?.at;
  return typeof iso === 'string' ? new Date(iso) : null;
}

async function saveSuccessfulSync(config: SupabaseServerConfig, at: Date, results: ProcessMessageResult[]): Promise<void> {
  const summary = results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  await supabaseStateRequest(config, 'sync_state?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key: 'gmail_last_successful_sync',
      value: { at: at.toISOString(), summary },
    }),
  });
}

export async function runDailySync(input: {
  google: GoogleOAuthCredentials;
  supabase: SupabaseServerConfig;
  now?: Date;
}): Promise<{ window: { from: string; to: string }; results: ProcessMessageResult[] }> {
  const now = input.now ?? new Date();
  const lastSuccessfulSync = await getLastSuccessfulSync(input.supabase);
  const window = buildSyncWindow({ now, lastSuccessfulSync, overlapMinutes: 15 });
  const accessToken = await refreshGoogleAccessToken(input.google);
  const ids = await listLifecycleMessageIds(accessToken, window);
  const messages = await Promise.all(ids.map((m) => getLifecycleMessage(accessToken, m.id)));
  messages.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));

  const repository = new SupabaseRestRepository(input.supabase);
  const results: ProcessMessageResult[] = [];
  for (const message of messages) {
    try {
      results.push(await processLifecycleMessage(message, repository, now));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await repository.createAlert({
        severity: 'error',
        alertType: 'gmail_ingestion_message_failure',
        message: `Unhandled processing failure for Gmail message ${message.id}`,
        context: { error: text, subject: message.subject },
      });
      results.push({ gmailMessageId: message.id, status: 'ERROR', outcome: text });
    }
  }

  const failed = results.filter((result) => result.status === 'ERROR');
  if (failed.length > 0) {
    throw new Error(`GMAIL_SYNC_INCOMPLETE:${failed.length}_MESSAGE_FAILURES`);
  }

  await saveSuccessfulSync(input.supabase, now, results);
  return { window: { from: window.from.toISOString(), to: window.to.toISOString() }, results };
}

export function envConfig(env: Record<string, string | undefined>): {
  google: GoogleOAuthCredentials;
  supabase: SupabaseServerConfig;
} {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`MISSING_ENV:${name}`);
    return value;
  };
  return {
    google: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
      refreshToken: required('GOOGLE_REFRESH_TOKEN'),
    },
    supabase: {
      url: required('SUPABASE_URL'),
      secretKey: required('SUPABASE_SECRET_KEY'),
    },
  };
}
