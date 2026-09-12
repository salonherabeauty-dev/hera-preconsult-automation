import type { SupabaseServerConfig } from './supabaseRest.js';
import type { WorkerRepository, StoredEventState } from './worker.js';
import type { ExistingBookingSnapshot, ReconciliationPlan } from './reconcile.js';
import type { GmailLifecycleMessage } from './gmailApi.js';
import type { TimelyAppointmentEvent, ClassificationResult, ServiceRule, ServiceCategory } from './types.js';
import type { AppointmentTiming } from './syncPolicy.js';
import { canonicalServiceName, INITIAL_HERA_RULES } from './serviceRules.js';

/** Only call with reads, deterministic upserts, or transactionally idempotent RPCs. */
export async function reliableSupabaseRequest<T>(config: SupabaseServerConfig, path: string, init: RequestInit = {}, label = 'SUPABASE_REST'): Promise<T> {
  const url = `${config.url.replace(/\/$/, '')}/rest/v1/${path}`;
  let lastError: Error = new Error(`${label}_REQUEST_FAILED`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (init.signal?.aborted) throw new Error(`${label}_CALLER_ABORTED`);
    init.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 12_000);
    let retry = false;
    let retryAfterMs = 0;
    try {
      const response = await fetch(url, {
        ...init, cache: 'no-store', signal: controller.signal,
        headers: { apikey: config.secretKey, ...(config.secretKey.startsWith('eyJ') ? { Authorization: `Bearer ${config.secretKey}` } : {}), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
      const text = await response.text();
      if (response.ok) return (text ? JSON.parse(text) : undefined) as T;
      let message = '';
      try { message = (JSON.parse(text) as { message?: string }).message ?? ''; } catch { /* gateway may return HTML */ }
      // Deterministic data errors are not transport failures and must never be retried as writes.
      if (message.startsWith('IDENTIFIER_CONFLICT') || message.startsWith('GMAIL_SYNC_INCOMPLETE')) throw new Error(message);
      lastError = new Error(`${label}_${response.status}:${text.slice(0, 700)}`);
      retry = [408, 429, 500, 502, 503, 504].includes(response.status) && !message.startsWith('INVALID_');
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = Math.min(retryAfter * 1000, 10_000);
      if (!retry) throw lastError;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (init.signal?.aborted || err.message.startsWith('IDENTIFIER_CONFLICT') || err.message.startsWith('GMAIL_SYNC_INCOMPLETE')) throw err;
      if (err === lastError && !retry) throw err;
      if (err.name === 'AbortError' || err.name === 'TimeoutError' || err instanceof TypeError) { retry = true; lastError = new Error(`${label}_TRANSPORT:${err.name}`); }
      else if (!retry) throw err;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
    if (!retry || attempt === 2) throw lastError;
    console.warn(JSON.stringify({ event: 'supabase_request_retry', route: path.split('?')[0], attempt: attempt + 1 }));
    await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfterMs, 500 * 2 ** attempt + Math.floor(Math.random() * 200))));
  }
  throw lastError;
}

export class AtomicSupabaseRepository implements WorkerRepository {
  private rulesPromise?: Promise<ServiceRule[]>;
  constructor(private readonly config: SupabaseServerConfig) {}
  private request<T>(path: string, init: RequestInit = {}): Promise<T> { return reliableSupabaseRequest<T>(this.config, path, init); }

  getServiceRules(): Promise<ServiceRule[]> {
    this.rulesPromise ??= this.request<Array<{ id: string; service_name: string; category: string; preconsult_required: boolean; priority: number }>>('service_rules?select=id,service_name,category,preconsult_required,priority&is_active=eq.true').then((rows) => {
      const valid: ServiceCategory[] = ['CURLY_HAIRCUT', 'CURLY_COLOUR', 'CURLY_HIGHLIGHTS_BALAYAGE', 'HIGHLIGHTS', 'BALAYAGE', 'COLOUR', 'COLOUR_CORRECTION', 'ROUTINE_COLOUR', 'EXCLUDED', 'MANUAL_REVIEW'];
      const exact = rows.map((row): ServiceRule => {
        const category = (row.category === 'curly' ? 'CURLY_HAIRCUT' : row.category.toUpperCase()) as ServiceCategory;
        if (!valid.includes(category)) throw new Error(`INVALID_SERVICE_RULE_CATEGORY:${row.id}`);
        return { id: row.id, priority: row.preconsult_required ? 3000 : 4000, category, preconsultRequired: row.preconsult_required, exactNames: [row.service_name] };
      });
      return [...exact, ...INITIAL_HERA_RULES];
    });
    return this.rulesPromise;
  }

  getEventState(gmailMessageId: string): Promise<StoredEventState> {
    return this.request('rpc/hera_event_state_v2', { method: 'POST', body: JSON.stringify({ p_message_id: gmailMessageId }) });
  }
  async startEvent(input: { message: GmailLifecycleMessage; event?: TimelyAppointmentEvent; parseStatus: 'processing' | 'error'; error?: string }): Promise<void> {
    const e = input.event;
    await this.request('timely_events?on_conflict=gmail_message_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({
      gmail_message_id: input.message.id, gmail_thread_id: input.message.threadId, event_type: e?.eventType.toLowerCase() ?? 'unknown', subject: input.message.subject, received_at: input.message.receivedAt,
      timely_customer_id: e?.customer.timelyCustomerId, timely_booking_id: e?.source.timelyBookingId, timely_change_token: e?.source.timelyChangeToken,
      client_name: e?.customer.name, client_email: e?.customer.email, client_mobile: e?.customer.mobile, service_name: e?.appointment.services[0]?.serviceName,
      stylist_name: e?.appointment.services[0]?.staffName, location_name: e?.appointment.locationName, appointment_at: e?.appointment.localIso,
      previous_appointment_at: e?.appointment.previousLocalIso, cancellation_reason: e?.appointment.cancellationReason, services: e?.appointment.services,
      parser_version: e?.parserVersion, parse_status: input.parseStatus, parse_error: input.error ?? null, processed_at: null,
      raw_payload: e ? { source: e.source, warnings: e.warnings } : undefined,
    }) });
  }
  listCandidateBookings(event: TimelyAppointmentEvent): Promise<ExistingBookingSnapshot[]> {
    return this.request('rpc/hera_lifecycle_candidates_v2', { method: 'POST', body: JSON.stringify({ p_event: event }) });
  }
  applyPlan(input: { message: GmailLifecycleMessage; event: TimelyAppointmentEvent; plan: ReconciliationPlan; classifications: Array<{ serviceName: string } & ClassificationResult>; timing: AppointmentTiming }): Promise<{ bookingId?: string; outcome: string }> {
    return this.request('rpc/hera_apply_lifecycle_v2', { method: 'POST', body: JSON.stringify({ p_input: { ...input, source: 'PRIMARY_VERCEL_WORKER' } }) });
  }
  async holdCancellationForReview(event: TimelyAppointmentEvent, messageId: string): Promise<void> {
    await this.request('rpc/hera_hold_cancellation_v2', { method: 'POST', body: JSON.stringify({ p_event: event, p_message_id: messageId }) });
  }
  async finishEvent(input: { gmailMessageId: string; bookingId?: string; parseStatus: 'parsed' | 'ignored' | 'manual_review' | 'error'; error?: string; identityResolution?: string }): Promise<void> {
    // An applied lifecycle was already marked parsed inside the atomic transaction.
    if (input.parseStatus === 'parsed' && input.bookingId) return;
    await this.request(`timely_events?gmail_message_id=eq.${encodeURIComponent(input.gmailMessageId)}`, { method: 'PATCH', body: JSON.stringify({ booking_id: input.bookingId, parse_status: input.parseStatus, parse_error: input.error ?? null, identity_resolution: input.identityResolution, processed_at: input.parseStatus === 'error' ? null : new Date().toISOString() }) });
  }
  async createAlert(input: { severity: 'info' | 'warning' | 'error' | 'critical'; alertType: string; message: string; context?: Record<string, unknown> }): Promise<void> {
    const services = input.context?.services;
    if (input.alertType.startsWith('unknown_') && Array.isArray(services) && services.every((s) => typeof s === 'string')) {
      for (const service of services as string[]) await this.request('rpc/hera_record_alert_v2', { method: 'POST', body: JSON.stringify({ p_alert: { ...input, dedupeKey: `service-policy:${canonicalServiceName(service)}`, context: { ...input.context, services: [service], serviceName: service } } }) });
      return;
    }
    const messageId = input.context?.gmailMessageId ?? input.context?.gmail_message_id ?? input.message;
    await this.request('rpc/hera_record_alert_v2', { method: 'POST', body: JSON.stringify({ p_alert: { ...input, dedupeKey: `${input.alertType}:${String(messageId)}` } }) });
  }
}
