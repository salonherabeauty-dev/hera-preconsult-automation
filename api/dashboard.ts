import { isDashboardAuthorized } from '../src/dashboardAuth.js';
import { dashboardSupabaseConfig, dashboardSupabaseFetch } from '../src/dashboardStore.js';

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
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  booking_services: BookingService[];
  preconsult_status: Preconsult | Preconsult[] | null;
};

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
      'id','timely_customer_id','client_name','client_email','client_mobile','service_name','service_category',
      'stylist_name','location_name','appointment_at','price','currency','booking_status','source',
      'latest_gmail_message_id','first_seen_at','last_seen_at','created_at','updated_at',
      'booking_services(id,service_name,staff_name,service_time,category,preconsult_required,matched_rule_id,classification_confidence)',
      'preconsult_status(id,required,workflow_status,whatsapp_sent_at,current_photos_received,inspiration_photos_received,maintenance_confirmed,maintenance_confirmed_at,completed_at,staff_notes,created_at,updated_at)',
    ].join(',');

    const [bookings, syncRows, alerts] = await Promise.all([
      dashboardSupabaseFetch<Booking[]>(config, `bookings?select=${encodeURIComponent(select)}&order=appointment_at.asc`),
      dashboardSupabaseFetch<Array<{ key: string; value: Record<string, unknown>; updated_at: string }>>(
        config,
        'sync_state?select=key,value,updated_at&key=eq.gmail_last_successful_sync&limit=1',
      ),
      dashboardSupabaseFetch<Array<{ id: string; severity: string; alert_type: string; message: string; context: Record<string, unknown> | null; created_at: string }>>(
        config,
        'system_alerts?select=id,severity,alert_type,message,context,created_at&resolved_at=is.null&order=created_at.desc&limit=25',
      ),
    ]);

    const qualifying = bookings
      .map((booking) => ({ ...booking, preconsult_status: one(booking.preconsult_status) }))
      .filter((booking) => booking.preconsult_status?.required === true);

    return Response.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      bookings: qualifying,
      lastSync: syncRows[0] ?? null,
      alerts,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
