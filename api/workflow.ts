import { isDashboardAuthorized } from '../src/dashboardAuth.js';
import { appendDashboardAudit, dashboardSupabaseConfig, dashboardSupabaseFetch } from '../src/dashboardStore.js';

type Preconsult = {
  booking_id: string;
  required: boolean;
  workflow_status: string;
  whatsapp_sent_at: string | null;
  current_photos_received: boolean;
  inspiration_photos_received: boolean;
  maintenance_confirmed: boolean;
  maintenance_confirmed_at: string | null;
  completed_at: string | null;
  staff_notes: string | null;
};

type BookingRow = {
  id: string;
  booking_status: string;
  client_name: string;
  service_category: string | null;
  appointment_at: string;
  preconsult_status: Preconsult | Preconsult[] | null;
};

function one<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<Response> {
  const env = process.env as Record<string, string | undefined>;
  if (!(await isDashboardAuthorized(request, env))) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: { bookingId?: string; action?: string; value?: boolean; notes?: string; messageText?: string } = {};
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'Invalid request.' }, { status: 400 }); }
  if (!body.bookingId || !UUID.test(body.bookingId) || !body.action) {
    return Response.json({ ok: false, error: 'Invalid booking/action.' }, { status: 400 });
  }

  try {
    const config = dashboardSupabaseConfig(env);
    const select = 'id,booking_status,client_name,service_category,appointment_at,preconsult_status(booking_id,required,workflow_status,whatsapp_sent_at,current_photos_received,inspiration_photos_received,maintenance_confirmed,maintenance_confirmed_at,completed_at,staff_notes)';
    const rows = await dashboardSupabaseFetch<BookingRow[]>(config, `bookings?select=${encodeURIComponent(select)}&id=eq.${body.bookingId}&limit=1`);
    const booking = rows[0];
    const status = booking ? one(booking.preconsult_status) : null;
    if (!booking || !status || !status.required) return Response.json({ ok: false, error: 'Qualifying booking not found.' }, { status: 404 });
    if (booking.booking_status === 'cancelled' && !['save_notes'].includes(body.action)) {
      return Response.json({ ok: false, error: 'Cancelled booking is blocked.' }, { status: 409 });
    }

    const now = new Date().toISOString();
    if (body.action === 'mark_sent') {
      if (status.whatsapp_sent_at) {
        return Response.json({ ok: true, alreadySent: true, sentAt: status.whatsapp_sent_at }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (new Date(booking.appointment_at).getTime() <= Date.now()) {
        return Response.json({ ok: false, error: 'This appointment has already passed. WhatsApp sending is blocked.' }, { status: 409 });
      }
    }
    const patch: Record<string, unknown> = {};
    let auditAction = '';
    const details: Record<string, unknown> = {};

    switch (body.action) {
      case 'mark_sent':
        patch.whatsapp_sent_at = now;
        patch.workflow_status = status.current_photos_received ? 'photos_received' : 'sent';
        auditAction = 'preconsult_whatsapp_marked_sent';
        if (body.messageText) details.message_text = body.messageText.slice(0, 4000);
        break;
      case 'set_current_photos':
        if (typeof body.value !== 'boolean') throw new Error('BOOLEAN_VALUE_REQUIRED');
        patch.current_photos_received = body.value;
        patch.workflow_status = body.value ? 'photos_received' : (status.whatsapp_sent_at ? 'sent' : 'to_contact');
        auditAction = body.value ? 'preconsult_current_photos_received' : 'preconsult_current_photos_unchecked';
        break;
      case 'set_inspiration_photos':
        if (typeof body.value !== 'boolean') throw new Error('BOOLEAN_VALUE_REQUIRED');
        patch.inspiration_photos_received = body.value;
        auditAction = body.value ? 'preconsult_inspiration_photos_received' : 'preconsult_inspiration_photos_unchecked';
        break;
      case 'set_maintenance':
        if (typeof body.value !== 'boolean') throw new Error('BOOLEAN_VALUE_REQUIRED');
        patch.maintenance_confirmed = body.value;
        patch.maintenance_confirmed_at = body.value ? now : null;
        patch.workflow_status = body.value ? 'completed' : (status.current_photos_received ? 'photos_received' : (status.whatsapp_sent_at ? 'sent' : 'to_contact'));
        patch.completed_at = body.value ? now : null;
        auditAction = body.value ? 'preconsult_maintenance_confirmed' : 'preconsult_maintenance_reopened';
        break;
      case 'complete':
        patch.workflow_status = 'completed';
        patch.completed_at = now;
        auditAction = 'preconsult_completed';
        break;
      case 'skip':
        patch.workflow_status = 'skipped';
        patch.completed_at = null;
        auditAction = 'preconsult_skipped';
        break;
      case 'reopen': {
        patch.completed_at = null;
        patch.workflow_status = status.current_photos_received ? 'photos_received' : (status.whatsapp_sent_at ? 'sent' : 'to_contact');
        auditAction = 'preconsult_reopened';
        break;
      }
      case 'save_notes':
        patch.staff_notes = (body.notes ?? '').slice(0, 3000);
        auditAction = 'preconsult_notes_updated';
        break;
      default:
        return Response.json({ ok: false, error: 'Unsupported action.' }, { status: 400 });
    }

    await dashboardSupabaseFetch(config, `preconsult_status?booking_id=eq.${body.bookingId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    await appendDashboardAudit(config, body.bookingId, auditAction, details);

    return Response.json({ ok: true, updatedAt: now }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
