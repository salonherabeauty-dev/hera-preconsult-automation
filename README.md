# Hera Pre-Consult Command Centre

Private production operations system for Hera Hair Beauty's pre-consult workflow.

## Production architecture

Timely appointment lifecycle email → Gmail API → deterministic parser/reconciliation → Supabase → private Vercel dashboard → human-reviewed WhatsApp.

The system never sends WhatsApp, SMS or email automatically.

## Reliability model

- Discovers Timely mail by verified sender and filters lifecycle events from message content, so subject wording changes do not silently drop bookings.
- Supports both Timely formats currently observed in production:
  - admin notifications (`Appointment confirmed/changed/cancelled ...`)
  - customer notifications (`Your appointment booking ... is confirmed`, `Your appointment ... has changed`, etc.)
- Uses Gmail message ID for idempotency and Timely booking UUID when available for highest-confidence reconciliation.
- Falls back deterministically to Timely customer ID, mobile/email, appointment time and service set. Ambiguity fails closed to manual review.
- Handles lifecycle scope transitions: a qualifying service changed to Root/Toner/non-target leaves the active queue; a previously non-target booking changed into a qualifying service can enter the queue.
- Cancelled bookings are hard-blocked. Duplicate cancellations are idempotent. Confirmations never silently resurrect a cancelled booking.
- Uses a database-backed ingestion lock so scheduled/manual/background scans cannot process the same window concurrently.
- A failed scan does not advance the successful checkpoint. Success and failure telemetry are stored separately.
- Normal scans overlap the previous checkpoint by 60 minutes; Gmail message-ID deduplication makes replay safe.
- A protected **Repair last 72h** action performs a controlled replay when history needs recovery. It does not contact clients.

## Live cadence

- Vercel production cron: every 15 minutes (`*/15 * * * *`).
- While the private dashboard is open, it performs a protected Gmail sync every 5 minutes and refreshes dashboard data every 60 seconds.
- Staff can also use **Scan Gmail now** for an immediate incremental scan.

If the hosting plan rejects the 15-minute cron schedule, deployment must not be treated as complete until either the plan supports it or the server-side cadence is deliberately changed and documented. The foreground five-minute sync is a convenience, not a substitute for unattended ingestion.

## Qualifying workflow

Current pre-consult scope is deterministic:

- qualifying: Balayage/AirTouch, Highlights, Colour Correction, configured Full Colour/general colour, qualifying Curly Haircut services
- excluded: Root/Regrowth/Root Tint, toner/toning-only, ordinary/children's haircuts and other non-target services
- fail closed: unfamiliar service names inside the colour/curly target domain go to manual review

A toner add-on does **not** exclude a genuine qualifying colour/highlight/balayage service.

## Dashboard intelligence

- **Contact now** is the exact 48-hour pre-consult window.
- **Upcoming** separates qualifying appointments outside that window instead of inflating the action queue.
- Shows active qualifying count, contact-now count, upcoming count, new bookings in 24h, photos received and completed work.
- Stores and displays:
  - original `booked_at` when proven by a CONFIRMED Timely email
  - `last_changed_at`
  - `appointment_at`
  - `cancelled_at`
  - `last_timely_event_at`
  - stable `timely_booking_id` when Timely exposes it
- `booked_at` is never invented. Existing records are backfilled only from actual confirmed Timely events.
- System-health panel shows last successful scan, last failure, discovered/lifecycle message counts, processed/duplicate totals and open alerts.

## WhatsApp workflow

The dashboard prepares category-aware messages, opens WhatsApp with a pre-filled draft, and requires staff to explicitly mark a message sent afterward.

No reply is **not** treated as an overdue photo request: clients maintaining their usual look are explicitly told there is nothing further to send. Staff track only operational facts such as message sent, current/inspiration photos received, maintenance confirmed, notes and completion.

## Security

Required Vercel environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `CRON_SECRET`
- `DASHBOARD_PASSWORD`

Controls:

- secrets remain server-side; the browser never receives Google OAuth, Supabase service credentials or the cron secret
- GUI session cookie is HttpOnly, Secure and SameSite=Strict
- production Supabase operational tables have RLS enabled with no public browser policies
- cron endpoint validates `CRON_SECRET`
- dashboard workflow endpoint blocks cancelled appointments and blocks `mark_sent` after an appointment has passed
- real secrets must never be committed to GitHub

## Database changes

Production DDL changes are migration-driven. See `supabase/migrations/`.

`supabase/schema.sql` is a historical bootstrap reference from an earlier stage and is **not** authoritative for the current live database. Do not run it against production.

## Verification

Before every production release:

```bash
npm install
npm test
```

`npm test` must pass TypeScript build, Vercel TypeScript build, all Node regression tests, and the dashboard JavaScript syntax check.

The 2026-08-18 production-hardening release passes 41/41 regression tests locally before deployment.
