import { getLifecycleMessage, listLifecycleMessageIds, refreshGoogleAccessToken, type GoogleOAuthCredentials } from './gmailApi.js';
import { SupabaseRestRepository, type SupabaseServerConfig } from './supabaseRest.js';
import { buildSyncWindow, type SyncWindow } from './syncPolicy.js';
import { looksLikeTimelyLifecycleMessage } from './timelyParser.js';
import { processLifecycleMessage, type ProcessMessageResult } from './worker.js';

interface SyncStateRow {
  key: string;
  value: Record<string, unknown>;
}

export interface SyncRunResult {
  window: { from: string; to: string; source: SyncWindow['source'] };
  results: ProcessMessageResult[];
  summary: Record<string, number>;
  scan: {
    timelyMessagesDiscovered: number;
    lifecycleMessages: number;
    nonLifecycleSkipped: number;
  };
  skippedDueToLock: boolean;
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

function summarize(results: ProcessMessageResult[]): Record<string, number> {
  return results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
}

async function saveSuccessfulSync(
  config: SupabaseServerConfig,
  at: Date,
  window: SyncWindow,
  results: ProcessMessageResult[],
  scan: SyncRunResult['scan'],
): Promise<void> {
  const summary = summarize(results);
  await supabaseStateRequest(config, 'sync_state?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key: 'gmail_last_successful_sync',
      value: {
        at: at.toISOString(),
        summary,
        scan,
        window: { from: window.from.toISOString(), to: window.to.toISOString(), source: window.source },
      },
    }),
  });
}

async function saveFailedSync(config: SupabaseServerConfig, at: Date, error: string, window?: SyncWindow): Promise<void> {
  try {
    await supabaseStateRequest(config, 'sync_state?on_conflict=key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        key: 'gmail_last_failed_sync',
        value: {
          at: at.toISOString(),
          error: error.slice(0, 1000),
          window: window ? { from: window.from.toISOString(), to: window.to.toISOString(), source: window.source } : null,
        },
      }),
    });
  } catch {
    // Never hide the original ingestion error because failure telemetry itself failed.
  }
}

async function acquireSyncLock(config: SupabaseServerConfig): Promise<string | null> {
  return supabaseStateRequest<string | null>(config, 'rpc/acquire_ingestion_lock', {
    method: 'POST',
    body: JSON.stringify({ p_lock_key: 'gmail_timely_ingestion', p_ttl_seconds: 1200 }),
  });
}

async function releaseSyncLock(config: SupabaseServerConfig, token: string): Promise<void> {
  try {
    await supabaseStateRequest(config, 'rpc/release_ingestion_lock', {
      method: 'POST',
      body: JSON.stringify({ p_lock_key: 'gmail_timely_ingestion', p_lock_token: token }),
    });
  } catch {
    // TTL makes lock release self-healing; do not turn a completed sync into a failure.
  }
}

function forcedWindow(now: Date, lookbackHours: number): SyncWindow {
  if (!Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 168) {
    throw new Error('INVALID_FORCE_LOOKBACK_HOURS');
  }
  return {
    from: new Date(now.getTime() - lookbackHours * 60 * 60_000),
    to: new Date(now),
    source: 'forced_lookback',
  };
}

async function fetchMessagesWithBoundedConcurrency(
  accessToken: string,
  ids: Array<{ id: string; threadId?: string }>,
): Promise<Awaited<ReturnType<typeof getLifecycleMessage>>[]> {
  const messages: Awaited<ReturnType<typeof getLifecycleMessage>>[] = [];
  const chunkSize = 10;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    messages.push(...await Promise.all(chunk.map((m) => getLifecycleMessage(accessToken, m.id))));
  }
  return messages;
}

export async function runDailySync(input: {
  google: GoogleOAuthCredentials;
  supabase: SupabaseServerConfig;
  now?: Date;
  forceLookbackHours?: number;
}): Promise<SyncRunResult> {
  const now = input.now ?? new Date();
  let window: SyncWindow | undefined;
  let lockToken: string | null = null;

  try {
    lockToken = await acquireSyncLock(input.supabase);
    if (!lockToken) {
      return {
        window: { from: now.toISOString(), to: now.toISOString(), source: 'last_successful_sync' },
        results: [],
        summary: {},
        scan: { timelyMessagesDiscovered: 0, lifecycleMessages: 0, nonLifecycleSkipped: 0 },
        skippedDueToLock: true,
      };
    }

    const lastSuccessfulSync = await getLastSuccessfulSync(input.supabase);
    window = input.forceLookbackHours
      ? forcedWindow(now, input.forceLookbackHours)
      : buildSyncWindow({ now, lastSuccessfulSync });

    const accessToken = await refreshGoogleAccessToken(input.google);
    const ids = await listLifecycleMessageIds(accessToken, window);
    const discovered = await fetchMessagesWithBoundedConcurrency(accessToken, ids);
    const messages = discovered.filter((m) => looksLikeTimelyLifecycleMessage(m.subject, m.body));
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
    if (failed.length > 0) throw new Error(`GMAIL_SYNC_INCOMPLETE:${failed.length}_MESSAGE_FAILURES`);

    const scan = {
      timelyMessagesDiscovered: discovered.length,
      lifecycleMessages: messages.length,
      nonLifecycleSkipped: discovered.length - messages.length,
    };
    await saveSuccessfulSync(input.supabase, now, window, results, scan);
    return {
      window: { from: window.from.toISOString(), to: window.to.toISOString(), source: window.source },
      results,
      summary: summarize(results),
      scan,
      skippedDueToLock: false,
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await saveFailedSync(input.supabase, now, text, window);
    throw error;
  } finally {
    if (lockToken) await releaseSyncLock(input.supabase, lockToken);
  }
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
