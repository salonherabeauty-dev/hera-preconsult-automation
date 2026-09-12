import { getLifecycleMessage, listLifecycleMessageIds, refreshGoogleAccessToken, type GoogleOAuthCredentials } from './gmailApi.js';
import { envConfig, type SyncRunResult } from './dailySync.js';
import type { SupabaseServerConfig } from './supabaseRest.js';
import { buildSyncWindow, type SyncWindow } from './syncPolicy.js';
import { looksLikeTimelyLifecycleMessage } from './timelyParser.js';
import { processLifecycleMessageV2 } from './workerV2.js';
import type { ProcessMessageResult } from './worker.js';
import { AtomicSupabaseRepository, reliableSupabaseRequest } from './reliableSupabase.js';
export { envConfig };

const SOURCE = 'PRIMARY_VERCEL_WORKER';
function summaryOf(results: ProcessMessageResult[]): Record<string, number> {
  return results.reduce<Record<string, number>>((counts, r) => { counts[r.status] = (counts[r.status] ?? 0) + 1; return counts; }, {});
}
export async function runDailySync(input: { google: GoogleOAuthCredentials; supabase: SupabaseServerConfig; now?: Date; forceLookbackHours?: number }): Promise<SyncRunResult> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const token = crypto.randomUUID();
  let locked = false;
  let window: SyncWindow | undefined;
  const state = <T>(path: string, init: RequestInit = {}): Promise<T> => reliableSupabaseRequest<T>(input.supabase, path, init, 'SUPABASE_SYNC_STATE');
  const rpc = <T>(name: string, body: unknown): Promise<T> => state<T>(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
  const budget = () => { if (Date.now() - started > 200_000) throw new Error('GMAIL_SYNC_INCOMPLETE:RUN_BUDGET_EXCEEDED'); };
  try {
    const acquired = await rpc<string | null>('hera_acquire_ingestion_lock_v2', { p_lock_key: 'gmail_timely_ingestion', p_lock_token: token, p_ttl_seconds: 1200 });
    if (!acquired) return { window: { from: now.toISOString(), to: now.toISOString(), source: 'last_successful_sync' }, results: [], summary: {}, scan: { timelyMessagesDiscovered: 0, lifecycleMessages: 0, nonLifecycleSkipped: 0 }, skippedDueToLock: true };
    locked = true;
    const rows = await state<Array<{ value: { at?: string } }>>('sync_state?select=value&key=eq.gmail_last_successful_sync&limit=1');
    const last = rows[0]?.value?.at ? new Date(rows[0].value.at) : null;
    if (last && !Number.isFinite(last.getTime())) throw new Error('INVALID_SUCCESS_CHECKPOINT');
    if (input.forceLookbackHours != null) {
      const hours = input.forceLookbackHours;
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('INVALID_FORCE_LOOKBACK_HOURS');
      window = { from: new Date(now.getTime() - hours * 3_600_000), to: now, source: 'forced_lookback' };
    } else window = buildSyncWindow({ now, lastSuccessfulSync: last });
    budget();
    const accessToken = await refreshGoogleAccessToken(input.google);
    const ids = await listLifecycleMessageIds(accessToken, window);
    const discovered: Awaited<ReturnType<typeof getLifecycleMessage>>[] = [];
    for (let index = 0; index < ids.length; index += 10) {
      budget();
      discovered.push(...await Promise.all(ids.slice(index, index + 10).map((m) => getLifecycleMessage(accessToken, m.id))));
    }
    const messages = discovered.filter((m) => looksLikeTimelyLifecycleMessage(m.subject, m.body)).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    const repository = new AtomicSupabaseRepository(input.supabase);
    const results: ProcessMessageResult[] = [];
    for (const message of messages) {
      budget();
      try { results.push(await processLifecycleMessageV2(message, repository, now)); }
      catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: 'timely_message_failed', messageId: message.id, error: text.slice(0, 700) }));
        try { await repository.createAlert({ severity: 'error', alertType: 'gmail_ingestion_message_failure', message: `Processing failure for Gmail message ${message.id}`, context: { gmailMessageId: message.id, error: text } }); }
        catch { console.error(JSON.stringify({ event: 'timely_failure_alert_write_failed', messageId: message.id })); }
        results.push({ gmailMessageId: message.id, status: 'ERROR', outcome: text });
      }
    }
    const failed = results.filter((r) => r.status === 'ERROR');
    if (failed.length) throw new Error(`GMAIL_SYNC_INCOMPLETE:${failed.length}_MESSAGE_FAILURES`);
    const summary = summaryOf(results);
    const scan = { timelyMessagesDiscovered: discovered.length, lifecycleMessages: messages.length, nonLifecycleSkipped: discovered.length - messages.length };
    const windowJson = { from: window.from.toISOString(), to: window.to.toISOString(), source: window.source };
    budget();
    await rpc('hera_complete_sync_v2', { p_value: { at: now.toISOString(), source: SOURCE, workerVersion: 'ATOMIC_V2', summary, scan, window: windowJson }, p_message_ids: messages.map((m) => m.id) });
    console.info(JSON.stringify({ event: 'timely_sync_completed', source: SOURCE, workerVersion: 'ATOMIC_V2', at: now.toISOString(), scan, summary }));
    return { window: windowJson, results, summary, scan, skippedDueToLock: false };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'timely_sync_failed', at: now.toISOString(), error: text.slice(0, 1000) }));
    try { await state('sync_state?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ key: 'gmail_last_failed_sync', value: { at: now.toISOString(), source: SOURCE, workerVersion: 'ATOMIC_V2', error: text.slice(0, 1000), window: window ? { from: window.from.toISOString(), to: window.to.toISOString(), source: window.source } : null } }) }); }
    catch { /* Preserve the original failure; do not advance success. */ }
    throw error;
  } finally {
    if (locked) {
      try { await rpc('release_ingestion_lock', { p_lock_key: 'gmail_timely_ingestion', p_lock_token: token }); }
      catch { console.warn(JSON.stringify({ event: 'timely_lease_release_deferred_to_ttl' })); }
    }
  }
}
