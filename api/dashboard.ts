import { isDashboardAuthorized } from '../src/dashboardAuth.js';
import { dashboardSupabaseConfig, dashboardSupabaseFetch } from '../src/dashboardStore.js';

const SYNC_CADENCE_MINUTES = 15;

type Preconsult = {
  id: string;
  required: boolean;
  workflow_status: string;
  whatsapp_sent_at: string | null;
  current_photos_received: boolean;
  inspiration_photos_received: boolean;
  maintenance_confirmed: boolean;
  maintenance_confirmed_at: string | null;
  completed_at: string | null;
  staff_notes: string | null;
  created_at: string;
  updated_at: string;
};

type BookingService = {
  id: string;
  service_name: string;
  staff_name: string | null;
  service_time: string | null;
  category: string | null;
  preconsult_required: boolean;
  matched_rule_id: string | null;
  classification_confidence: string | null;
};

type Booking = {
  id: string;
  timely_customer_id: string | null;
  timely_booking_id: string | null;
  client_name: string;
  client_email: string | null;
  client_mobile: string | null;
  service_name: string;
  service_category: string | null;
  stylist_name: string | null;
  location_name: string | null;
  appointment_at: string;
  price: number | null;
  currency: string;
  booking_status: string;
  source: string;
  latest_gmail_message_id: string | null;
  booked_at: string | null;
  last_changed_at: string | null;
  cancelled_at: string | null;
  last_timely_event_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  booking_services: BookingService[];
  preconsult_status: Preconsult | Preconsult[] | null;
};

type SyncState = { key: string; value: Record<string, unknown>; updated_at: string };

function one<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

export async function GET(request: Request): Promise<Response> {
  const env = process.env as Record<string, string | undefined>;
  if (!(await isDashboardAuthorized(request, env))) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const config = dashboardSupabaseConfig(env);
    const select = [
      'id','timely_customer_id','timely_booking_id','client_name','client_email','client_mobile','service_name','service_category',
      'stylist_name','location_name','appointment_at','price','currency','booking_status','source',
      'latest_gmail_message_id','booked_at','last_changed_at','cancelled_at','last_timely_event_at',
      'first_seen_at','last_seen_at','created_at','updated_at',
      'booking_services(id,service_name,staff_name,service_time,category,preconsult_required,matched_rule_id,classification_confidence)',
      'preconsult_status(id,required,workflow_status,whatsapp_sent_at,current_photos_received,inspiration_photos_received,maintenance_confirmed,maintenance_confirmed_at,completed_at,staff_notes,created_at,updated_at)',
    ].join(',');
    const historyFloor = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();

    const [bookings, syncRows, alerts] = await Promise.all([
      dashboardSupabaseFetch<Booking[]>(config, `bookings?select=${encodeURIComponent(select)}&appointment_at=gte.${encodeURIComponent(historyFloor)}&order=appointment_at.asc&limit=2000`),
      dashboardSupabaseFetch<SyncState[]>(
        config,
        'sync_state?select=key,value,updated_at&key=in.(gmail_last_successful_sync,gmail_last_failed_sync)',
      ),
      dashboardSupabaseFetch<Array<{ id: string; severity: string; alert_type: string; message: string; context: Record<string, unknown> | null; created_at: string }>>(
        config,
        'system_alerts?select=id,severity,alert_type,message,context,created_at&resolved_at=is.null&order=created_at.desc&limit=25',
      ),
    ]);

    const qualifying = bookings
      .map((booking) => ({ ...booking, preconsult_status: one(booking.preconsult_status) }))
      .filter((booking) =>
        booking.preconsult_status?.required === true
        && booking.booking_services?.some((service) => service.preconsult_required === true),
      );

    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      syncCadenceMinutes: SYNC_CADENCE_MINUTES,
      bookings: qualifying,
      lastSync: syncRows.find((row) => row.key === 'gmail_last_successful_sync') ?? null,
      lastFailure: syncRows.find((row) => row.key === 'gmail_last_failed_sync') ?? null,
      alerts,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
