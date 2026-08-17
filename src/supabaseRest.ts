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
      client_name: input.event?.customer.name,
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
    if (event.source.timelyBookingId) filters.push(`timely_booking_id.eq.${encodeEq(event.source.timelyBookingId)}`);
    if (event.customer.timelyCustomerId) filters.push(`timely_customer_id.eq.${encodeEq(event.customer.timelyCustomerId)}`);
    if (event.customer.mobile) filters.push(`client_mobile.eq.${encodeEq(event.customer.mobile)}`);
    if (event.customer.email) filters.push(`client_email.ilike.${encodeEq(event.customer.email)}`);
    if (!filters.length) return [];

    const query = new URLSearchParams({
      select: 'id,timely_customer_id,timely_booking_id,client_mobile,client_email,appointment_at,booking_status,booking_services(service_name)',
      or: `(${filters.join(',')})`,
      limit: '50',
    });

    const rows = await this.request<Array<{
      id: string;
      timely_customer_id?: string;
      timely_booking_id?: string;
      client_mobile?: string;
      client_email?: string;
      appointment_at: string;
      booking_status: string;
      booking_services?: Array<{ service_name: string }>;
    }>>(`bookings?${query.toString()}`);

    return rows.map((row) => ({
      id: row.id,
      timelyCustomerId: row.timely_customer_id,
      timelyBookingId: row.timely_booking_id,
      mobile: row.client_mobile,
      email: row.client_email,
      appointmentLocalIso: row.appointment_at,
      serviceNames: row.booking_services?.map((s) => s.service_name) ?? [],
      status: row.booking_status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    }));
  }

  private async attachStableBookingIdIfMissing(bookingId: string, timelyBookingId?: string): Promise<void> {
    if (!timelyBookingId) return;
    await this.request(`bookings?id=eq.${bookingId}&timely_booking_id=is.null`, {
      method: 'PATCH',
      body: JSON.stringify({ timely_booking_id: timelyBookingId }),
    });
  }

  private async attachBookedAtIfMissing(bookingId: string, event: TimelyAppointmentEvent, receivedAt: string): Promise<void> {
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
    const required = classifications.some((c) => c.preconsultRequired);
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

    if (!current.required) {
      // Re-entering qualifying scope is a new operational task. Historical state
      // remains in audit_logs, while active workflow fields are reset so staff do
      // not accidentally rely on photos/maintenance decisions for the old service.
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

  private async touchBooking(bookingId: string, message: GmailLifecycleMessage, event: TimelyAppointmentEvent): Promise<void> {
    await this.attachStableBookingIdIfMissing(bookingId, event.source.timelyBookingId);
    await this.attachBookedAtIfMissing(bookingId, event, message.receivedAt);
    await this.request(`bookings?id=eq.${bookingId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        timely_customer_id: event.customer.timelyCustomerId,
        client_name: event.customer.name,
        client_email: event.customer.email,
        client_mobile: event.customer.mobile,
        latest_gmail_message_id: message.id,
        last_timely_event_at: message.receivedAt,
        last_seen_at: message.receivedAt,
      }),
    });
    await this.request('audit_logs', {
      method: 'POST',
      body: JSON.stringify({
        booking_id: bookingId,
        action: 'timely_event_matched_existing_booking',
        details: { gmail_message_id: message.id, event_type: event.eventType, parser_version: event.parserVersion },
      }),
    });
  }

  private async createBooking(
    message: GmailLifecycleMessage,
    event: TimelyAppointmentEvent,
    classifications: Array<{ serviceName: string } & ClassificationResult>,
    timing: AppointmentTiming,
  ): Promise<string> {
    const primary = classifications.find((c) => c.category !== 'EXCLUDED') ?? classifications[0];
    const required = classifications.some((c) => c.preconsultRequired);
    const workflow = required ? 'to_contact' : 'not_required';
    const firstService = event.appointment.services[0];

    const created = await this.request<Array<{ id: string }>>('bookings?select=id', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        timely_customer_id: event.customer.timelyCustomerId,
        timely_booking_id: event.source.timelyBookingId,
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
        booked_at: message.receivedAt,
        last_timely_event_at: message.receivedAt,
        first_seen_at: message.receivedAt,
        last_seen_at: message.receivedAt,
      }),
    });
    const bookingId = created[0]?.id;
    if (!bookingId) throw new Error('SUPABASE_BOOKING_ID_MISSING');

    await this.request('booking_services', {
      method: 'POST',
      body: JSON.stringify(event.appointment.services.map((service) => {
        const c = classifications.find((x) => x.serviceName === service.serviceName)!;
        return {
          booking_id: bookingId,
          service_name: service.serviceName,
          staff_name: service.staffName,
          service_time: service.serviceTime,
          category: dbCategory(c.category),
          preconsult_required: c.preconsultRequired,
          matched_rule_id: c.matchedRuleId,
          classification_confidence: c.confidence,
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
        action: 'booking_created_from_timely_email',
        details: { gmail_message_id: message.id, timing, parser_version: event.parserVersion, timely_booking_id: event.source.timelyBookingId },
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
    const primary = classifications.find((c) => c.category !== 'EXCLUDED') ?? classifications[0];
    const firstService = event.appointment.services[0];
    await this.attachStableBookingIdIfMissing(bookingId, event.source.timelyBookingId);
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
      }),
    });
    await this.request(`booking_services?booking_id=eq.${bookingId}`, { method: 'DELETE' });
    await this.request('booking_services', {
      method: 'POST',
      body: JSON.stringify(event.appointment.services.map((service) => {
        const c = classifications.find((x) => x.serviceName === service.serviceName)!;
        return {
          booking_id: bookingId,
          service_name: service.serviceName,
          staff_name: service.staffName,
          service_time: service.serviceTime,
          category: dbCategory(c.category),
          preconsult_required: c.preconsultRequired,
          matched_rule_id: c.matchedRuleId,
          classification_confidence: c.confidence,
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
          preconsult_required: classifications.some((c) => c.preconsultRequired),
          services: event.appointment.services.map((service) => service.serviceName),
        },
      }),
    });
  }

  private async cancelBooking(bookingId: string, message: GmailLifecycleMessage, event: TimelyAppointmentEvent): Promise<void> {
    await this.attachStableBookingIdIfMissing(bookingId, event.source.timelyBookingId);
    await this.request(`bookings?id=eq.${bookingId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        booking_status: 'cancelled',
        latest_gmail_message_id: message.id,
        cancelled_at: message.receivedAt,
        last_timely_event_at: message.receivedAt,
        last_seen_at: message.receivedAt,
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
        details: { gmail_message_id: message.id, reason: event.appointment.cancellationReason },
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
  }): Promise<void> {
    await this.request(`timely_events?gmail_message_id=eq.${encodeURIComponent(input.gmailMessageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        booking_id: input.bookingId,
        parse_status: input.parseStatus,
        parse_error: input.error,
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
