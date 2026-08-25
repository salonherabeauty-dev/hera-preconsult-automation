import type { ExistingBookingSnapshot, ReconciliationPlan } from './reconcile.js';
import type { AppointmentTiming } from './syncPolicy.js';
import type { ClassificationResult, TimelyAppointmentEvent } from './types.js';
import type { GmailLifecycleMessage } from './gmailApi.js';
import type { StoredEventState, WorkerRepository } from './worker.js';

export interface SupabaseServerConfig {
  url: string;
  secretKey: string;
}

type JsonRecord = Record<string, unknown>;

function encodeEq(value: string): string {
  return value.replace(/,/g, '\\,').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function dbCategory(category: string): string {
  return category.toLowerCase();
}

function serviceTimeMinutes(value?: string): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const match = value.match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  return hour * 60 + Number(match[2]);
}

function identityResolution(event: TimelyAppointmentEvent): string {
  if (event.source.timelyBookingId && event.source.timelyChangeToken) return 'ICS_UID_AND_CHANGE_TOKEN_VERIFIED';
  if (event.source.timelyBookingId) return 'ICS_UID_VERIFIED';
  if (event.source.timelyChangeToken) return 'CHANGE_TOKEN_VERIFIED';
  return 'NO_STABLE_IDENTIFIER';
}

export class SupabaseRestRepository implements WorkerRepository {
  constructor(private readonly config: SupabaseServerConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.config.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.config.secretKey,
        ...(this.config.secretKey.startsWith('eyJ') ? { Authorization: `Bearer ${this.config.secretKey}` } : {}),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SUPABASE_REST_${response.status}:${text.slice(0, 700)}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async getEventState(gmailMessageId: string): Promise<StoredEventState> {
    const rows = await this.request<Array<{ processed_at: string | null }>>(
      `timely_events?select=processed_at&gmail_message_id=eq.${encodeURIComponent(gmailMessageId)}&limit=1`,
    );
    return rows.length ? { exists: true, processed: Boolean(rows[0].processed_at) } : { exists: false, processed: false };
  }

  async startEvent(input: {
    message: GmailLifecycleMessage;
    event?: TimelyAppointmentEvent;
    parseStatus: 'processing' | 'error';
    error?: string;
  }): Promise<void> {
    const payload: JsonRecord = {
      gmail_message_id: input.message.id,
      gmail_thread_id: input.message.threadId,
      event_type: input.event?.eventType.toLowerCase() ?? 'unknown',
      subject: input.message.subject,
      received_at: input.message.receivedAt,
      timely_customer_id: input.event?.customer.timelyCustomerId,
      timely_booking_id: input.event?.source.timelyBookingId,
      timely_change_token: input.event?.source.timelyChangeToken,
      client_name: input.event?.customer.name,
      client_email: input.event?.customer.email,
      client_mobile: input.event?.customer.mobile,
      service_name: input.event?.appointment.services[0]?.serviceName,
      stylist_name: input.event?.appointment.services[0]?.staffName,
      location_name: input.event?.appointment.locationName,
      appointment_at: input.event?.appointment.localIso,
      previous_appointment_at: input.event?.appointment.previousLocalIso,
      cancellation_reason: input.event?.appointment.cancellationReason,
      services: input.event?.appointment.services,
      parser_version: input.event?.parserVersion,
      parse_status: input.parseStatus,
      parse_error: input.error,
      identity_resolution: input.event ? identityResolution(input.event) : undefined,
      raw_payload: input.event ? { source: input.event.source, warnings: input.event.warnings } : undefined,
    };

    await this.request('timely_events?on_conflict=gmail_message_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(payload),
    });
  }

  async listCandidateBookings(event: TimelyAppointmentEvent): Promise<ExistingBookingSnapshot[]> {
    const filters: string[] = [];
    if (event.source.timelyBookingId) {
      filters.push(`timely_booking_id.eq.${encodeEq(event.source.timelyBookingId)}`);
    }
    if (event.source.timelyChangeToken) {
      filters.push(`timely_change_token.eq.${encodeEq(event.source.timelyChangeToken)}`);
      filters.push(`timely_booking_id.eq.${encodeEq(event.source.timelyChangeToken)}`);
    }
    if (event.customer.timelyCustomerId) filters.push(`timely_customer_id.eq.${encodeEq(event.customer.timelyCustomerId)}`);
    if (event.customer.mobile) filters.push(`client_mobile.eq.${encodeEq(event.customer.mobile)}`);
    if (event.customer.email) filters.push(`client_email.ilike.${encodeEq(event.customer.email)}`);
    if (!filters.length) return [];

    const query = new URLSearchParams({
      select: 'id,timely_customer_id,timely_booking_id,timely_change_token,client_mobile,client_email,appointment_at,location_name,last_timely_event_at,booking_status,booking_services(service_name,service_time)',
      or: `(${filters.join(',')})`,
      limit: '50',
    });

    const rows = await this.request<Array<{
      id: string;
      timely_customer_id?: string;
      timely_booking_id?: string;
      timely_change_token?: string;
      client_mobile?: string;
      client_email?: string;
      appointment_at: string;
      location_name?: string;
      last_timely_event_at?: string;
      booking_status: string;
      booking_services?: Array<{ service_name: string; service_time?: string }>;
    }>>(`bookings?${query.toString()}`);

    return rows.map((row) => ({
      id: row.id,
      timelyCustomerId: row.timely_customer_id,
      timelyBookingId: row.timely_booking_id,
      timelyChangeToken: row.timely_change_token,
      mobile: row.client_mobile,
      email: row.client_email,
      appointmentLocalIso: row.appointment_at,
      locationName: row.location_name,
      serviceNames: [...(row.booking_services ?? [])]
        .sort((a, b) => serviceTimeMinutes(a.service_time) - serviceTimeMinutes(b.service_time))
        .map((service) => service.service_name),
      lastTimelyEventAt: row.last_timely_event_at,
      status: row.booking_status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    }));
  }

  private async assertAndInsertIdentity(input: {
    bookingId: string;
    identifierType: 'ics_uid' | 'change_token';
    identifierValue: string;
    message: GmailLifecycleMessage;
    event: TimelyAppointmentEvent;
  }): Promise<void> {
    const rows = await this.request<Array<{ booking_id: string }>>(
      `booking_identities?select=booking_id&identifier_type=eq.${encodeURIComponent(input.identifierType)}&identifier_value=eq.${encodeURIComponent(input.identifierValue)}`,
    );
    const conflicting = rows.find((row) => row.booking_id !== input.bookingId);
    if (conflicting) {
      throw new Error(
        `IDENTIFIER_CONFLICT:${input.identifierType}:${input.identifierValue}:existing=${conflicting.booking_id}:incoming=${input.bookingId}`,
      );
    }
    if (rows.length) return;

    await this.request('booking_identities?on_conflict=identifier_type,identifier_value', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({
        booking_id: input.bookingId,
        identifier_type: input.identifierType,
        identifier_value: input.identifierValue,
        first_seen_gmail_message_id: input.message.id,
        first_seen_event_type: input.event.eventType.toLowerCase(),
      }),
    });
  }

  private async attachStableIdentities(
    bookingId: string,
    message: GmailLifecycleMessage,
    event: TimelyAppointmentEvent,
  ): Promise<void> {
    const uid = event.source.timelyBookingId;
    const token = event.source.timelyChangeToken;
    if (!uid && !token) return;

    const rows = await this.request<Array<{
      timely_booking_id?: string;
      timely_change_token?: string;
    }>>(`bookings?select=timely_booking_id,timely_change_token&id=eq.${bookingId}&limit=1`);
    const current = rows[0];
    if (!current) throw new Error(`BOOKING_NOT_FOUND:${bookingId}`);

    let currentUid = current.timely_booking_id;
    let currentToken = current.timely_change_token;
    const patch: JsonRecord = {};

    if (uid && currentUid && currentUid !== uid) {
      if (token && currentUid === token && !currentToken) {
        currentToken = token;
        currentUid = uid;
        patch.timely_booking_id = uid;
        patch.timely_change_token = token;
        patch.identity_resolution = 'LEGACY_CHANGE_TOKEN_MOVED_TO_CORRECT_COLUMN';
      } else {
        throw new Error(`IDENTIFIER_CONFLICT:ics_uid:${uid}:booking=${bookingId}:existing=${currentUid}`);
      }
    }
    if (token && currentToken && currentToken !== token) {
      throw new Error(`IDENTIFIER_CONFLICT:change_token:${token}:booking=${bookingId}:existing=${currentToken}`);
    }
    if (uid && !currentUid) {
      currentUid = uid;
      patch.timely_booking_id = uid;
    }
    if (token && !currentToken) {
      currentToken = token;
      patch.timely_change_token = token;
    }
    if (Object.keys(patch).length) {
      await this.request(`bookings?id=eq.${bookingId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    }

    if (uid) {
      await this.assertAndInsertIdentity({
        bookingId,
        identifierType: 'ics_uid',
        identifierValue: uid,
        message,
        event,
      });
    }
    if (token) {
      await this.assertAndInsertIdentity({
        bookingId,
        identifierType: 'change_token',
        identifierValue: token,
        message,
        event,
      });
    }
  }

  private async attachBookedAtIfMissing(
    bookingId: string,
    event: TimelyAppointmentEvent,
    receivedAt: string,
  ): Promise<void> {
    if (event.eventType !== 'CONFIRMED') return;
    await this.request(`bookings?id=eq.${bookingId}&booked_at=is.null`, {
      method: 'PATCH',
      body: JSON.stringify({ booked_at: receivedAt }),
    });
  }

  private async syncPreconsultRequirement(
    bookingId: string,
    classifications: Array<{ serviceName: string } & ClassificationResult>,
  ): Promise<void> {
    const required = classifications.some((classification) => classification.preconsultRequired);
    const rows = await this.request<Array<{ required: boolean; workflow_status: string }>>(
      `preconsult_status?select=required,workflow_status&booking_id=eq.${bookingId}&limit=1`,
    );
    const current = rows[0];
    if (!current) throw new Error(`PRECONSULT_STATUS_MISSING:${bookingId}`);

    if (!required) {
      if (current.required || current.workflow_status !== 'not_required') {
        await this.request(`preconsult_status?booking_id=eq.${bookingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ required: false, workflow_status: 'not_required' }),
        });
      }
      return;
    }

    if (!current.required || current.workflow_status === 'not_required') {
      await this.request(`preconsult_status?booking_id=eq.${bookingId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          required: true,
          workflow_status: 'to_contact',
          whatsapp_sent_at: null,
          current_photos_received: false,
          inspiration_photos_received: false,
          maintenance_confirmed: false,
          maintenance_confirmed_at: null,
          completed_at: null,
        }),
      });
    }
  }

  private async touchBooking(
    bookingId: string,
    message: GmailLifecycleMessage,
    event: TimelyAppointmentEvent,
  ): Promise<void> {
    await this.attachStableIdentities(bookingId, message, event);
    await this.attachBookedAtIfMissing(bookingId, event, message.receivedAt);

    if (event.customer.email) {
      await this.request(`bookings?id=eq.${bookingId}&client_email=is.null`, {
        method: 'PATCH',
        body: JSON.stringify({ client_email: event.customer.email }),
      });
    }
    if (event.customer.mobile) {
      await this.request(`bookings?id=eq.${bookingId}&client_mobile=is.null`, {
        method: 'PATCH',
        body: JSON.stringify({ client_mobile: event.customer.mobile }),
      });
    }

    await this.request('audit_logs', {
      method: 'POST',
      body: JSON.stringify({
        booking_id: bookingId,
        action: 'timely_event_noop_or_identity_enrichment',
        details: {
          gmail_message_id: message.id,
          event_type: event.eventType,
          parser_version: event.parserVersion,
          timely_booking_id: event.source.timelyBookingId,
          timely_change_token: event.source.timelyChangeToken,
        },
      }),
    });
  }

  private async createBooking(
    message: GmailLifecycleMessage,
    event: TimelyAppointmentEvent,
    classifications: Array<{ serviceName: string } & ClassificationResult>,
    timing: AppointmentTiming,
  ): Promise<string> {
    const primary = classifications.find((classification) => classification.category !== 'EXCLUDED') ?? classifications[0];
    const required = classifications.some((classification) => classification.preconsultRequired);
    const workflow = required ? 'to_contact' : 'not_required';
    const firstService = event.appointment.services[0];

    const created = await this.request<Array<{ id: string }>>('bookings?select=id', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        timely_customer_id: event.customer.timelyCustomerId,
        timely_booking_id: event.source.timelyBookingId,
        timely_change_token: event.source.timelyChangeToken,
        client_name: event.customer.name,
        client_email: event.customer.email,
        client_mobile: event.customer.mobile,
        service_name: firstService.serviceName,
        service_category: dbCategory(primary.category),
        stylist_name: firstService.staffName,
        location_name: event.appointment.locationName,
        appointment_at: event.appointment.localIso,
        price: event.appointment.totalPrice,
        booking_status: 'confirmed',
        latest_gmail_message_id: message.id,
        booked_at: event.eventType === 'CONFIRMED' ? message.receivedAt : null,
        last_timely_event_at: message.receivedAt,
        first_seen_at: message.receivedAt,
        last_seen_at: message.receivedAt,
        identity_resolution: identityResolution(event),
      }),
    });
    const bookingId = created[0]?.id;
    if (!bookingId) throw new Error('SUPABASE_BOOKING_ID_MISSING');

    await this.attachStableIdentities(bookingId, message, event);

    await this.request('booking_services', {
      method: 'POST',
      body: JSON.stringify(event.appointment.services.map((service) => {
        const classification = classifications.find((item) => item.serviceName === service.serviceName)!;
        return {
          booking_id: bookingId,
          service_name: service.serviceName,
          staff_name: service.staffName,
          service_time: service.serviceTime,
          category: dbCategory(classification.category),
          preconsult_required: classification.preconsultRequired,
          matched_rule_id: classification.matchedRuleId,
          classification_confidence: classification.confidence,
        };
      })),
    });

    await this.request('preconsult_status', {
      method: 'POST',
      body: JSON.stringify({
        booking_id: bookingId,
        required,
        workflow_status: workflow,
        staff_notes: timing === 'SAME_DAY_URGENT' ? 'Same-day booking detected by Gmail ingestion.' : null,
      }),
    });

    await this.request('audit_logs', {
      method: 'POST',
      body: JSON.stringify({
        booking_id: bookingId,
        action: event.eventType === 'CHANGED'
          ? 'booking_recovered_from_verified_changed_email'
          : 'booking_created_from_timely_email',
        details: {
          gmail_message_id: message.id,
          timing,
          parser_version: event.parserVersion,
          timely_booking_id: event.source.timelyBookingId,
          timely_change_token: event.source.timelyChangeToken,
        },
      }),
    });
    return bookingId;
  }

  private async updateBooking(
    bookingId: string,
    message: GmailLifecycleMessage,
    event: TimelyAppointmentEvent,
    classifications: Array<{ serviceName: string } & ClassificationResult>,
  ): Promise<void> {
    const primary = classifications.find((classification) => classification.category !== 'EXCLUDED') ?? classifications[0];
    const firstService = event.appointment.services[0];
    await this.attachStableIdentities(bookingId, message, event);
    await this.request(`bookings?id=eq.${bookingId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        timely_customer_id: event.customer.timelyCustomerId,
        client_name: event.customer.name,
        client_email: event.customer.email,
        client_mobile: event.customer.mobile,
        appointment_at: event.appointment.localIso,
        service_name: firstService.serviceName,
        service_category: dbCategory(primary.category),
        stylist_name: firstService.staffName,
        location_name: event.appointment.locationName,
        price: event.appointment.totalPrice,
        booking_status: event.eventType === 'CHANGED' ? 'changed' : 'confirmed',
        latest_gmail_message_id: message.id,
        last_changed_at: event.eventType === 'CHANGED' ? message.receivedAt : undefined,
        last_timely_event_at: message.receivedAt,
        last_seen_at: message.receivedAt,
        identity_resolution: identityResolution(event),
      }),
    });
    await this.attachBookedAtIfMissing(bookingId, event, message.receivedAt);
    await this.request(`booking_services?booking_id=eq.${bookingId}`, { method: 'DELETE' });
    await this.request('booking_services', {
      method: 'POST',
      body: JSON.stringify(event.appointment.services.map((service) => {
        const classification = classifications.find((item) => item.serviceName === service.serviceName)!;
        return {
          booking_id: bookingId,
          service_name: service.serviceName,
          staff_name: service.staffName,
          service_time: service.serviceTime,
          category: dbCategory(classification.category),
          preconsult_required: classification.preconsultRequired,
          matched_rule_id: classification.matchedRuleId,
          classification_confidence: classification.confidence,
        };
      })),
    });
    await this.syncPreconsultRequirement(bookingId, classifications);
    await this.request('audit_logs', {
      method: 'POST',
      body: JSON.stringify({
        booking_id: bookingId,
        action: 'booking_changed_from_timely_email',
        details: {
          gmail_message_id: message.id,
          preconsult_required: classifications.some((classification) => classification.preconsultRequired),
          services: event.appointment.services.map((service) => service.serviceName),
          timely_booking_id: event.source.timelyBookingId,
          timely_change_token: event.source.timelyChangeToken,
        },
      }),
    });
  }

  private async cancelBooking(
    bookingId: string,
    message: GmailLifecycleMessage,
    event: TimelyAppointmentEvent,
  ): Promise<void> {
    await this.attachStableIdentities(bookingId, message, event);
    await this.request(`bookings?id=eq.${bookingId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        booking_status: 'cancelled',
        latest_gmail_message_id: message.id,
        cancelled_at: message.receivedAt,
        last_timely_event_at: message.receivedAt,
        last_seen_at: message.receivedAt,
        identity_resolution: identityResolution(event),
      }),
    });
    await this.request(`preconsult_status?booking_id=eq.${bookingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ workflow_status: 'blocked_cancelled' }),
    });
    await this.request('audit_logs', {
      method: 'POST',
      body: JSON.stringify({
        booking_id: bookingId,
        action: 'booking_cancelled_from_timely_email',
        details: {
          gmail_message_id: message.id,
          reason: event.appointment.cancellationReason,
          timely_booking_id: event.source.timelyBookingId,
          timely_change_token: event.source.timelyChangeToken,
        },
      }),
    });
  }

  async applyPlan(input: {
    message: GmailLifecycleMessage;
    event: TimelyAppointmentEvent;
    plan: ReconciliationPlan;
    classifications: Array<{ serviceName: string } & ClassificationResult>;
    timing: AppointmentTiming;
  }): Promise<{ bookingId?: string; outcome: string }> {
    if (input.plan.action === 'NOOP') {
      await this.touchBooking(input.plan.bookingId, input.message, input.event);
      return { bookingId: input.plan.bookingId, outcome: input.plan.reason };
    }
    if (input.plan.action === 'CREATE') {
      const bookingId = await this.createBooking(input.message, input.event, input.classifications, input.timing);
      return { bookingId, outcome: input.plan.reason };
    }
    if (input.plan.action === 'UPDATE') {
      await this.updateBooking(input.plan.bookingId, input.message, input.event, input.classifications);
      return { bookingId: input.plan.bookingId, outcome: input.plan.reason };
    }
    if (input.plan.action === 'CANCEL') {
      await this.cancelBooking(input.plan.bookingId, input.message, input.event);
      return { bookingId: input.plan.bookingId, outcome: input.plan.reason };
    }
    throw new Error('NEEDS_REVIEW_PLAN_MUST_NOT_BE_APPLIED');
  }

  async finishEvent(input: {
    gmailMessageId: string;
    bookingId?: string;
    parseStatus: 'parsed' | 'ignored' | 'manual_review' | 'error';
    error?: string;
    identityResolution?: string;
  }): Promise<void> {
    await this.request(`timely_events?gmail_message_id=eq.${encodeURIComponent(input.gmailMessageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        booking_id: input.bookingId,
        parse_status: input.parseStatus,
        parse_error: input.error,
        identity_resolution: input.identityResolution,
        processed_at: new Date().toISOString(),
      }),
    });
  }

  async createAlert(input: {
    severity: 'info' | 'warning' | 'error' | 'critical';
    alertType: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<void> {
    await this.request('system_alerts', {
      method: 'POST',
      body: JSON.stringify({
        severity: input.severity,
        alert_type: input.alertType,
        message: input.message,
        context: input.context,
      }),
    });
  }
}
