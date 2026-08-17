# Hera Pre-Consult Automation — Stage 1

This is the first production-oriented component of the Hera Hair Beauty pre-consultation system: a deterministic parser for Timely appointment notification emails plus a service classification engine.

## What is implemented

- Timely email event detection: `CONFIRMED`, `CHANGED`, `CANCELLED`
- Appointment date/time parsing in Singapore time (`+08:00`)
- Service name, stylist and service time extraction
- Client name, email, mobile and Timely customer ID extraction
- Location and total-price extraction
- Cancellation reason extraction
- Changed-booking old time extraction when Timely includes the `Recent activity` line
- Deterministic booking fingerprints
- Gmail message ID dedupe key support
- Fail-closed service classification (`MANUAL_REVIEW` when unknown)
- Initial exact Hera service names observed in real Timely notification formats
- Tests using anonymised fixtures modeled on real Hera emails

## Important safety design

The parser does **not** use an LLM to guess client identity, service or appointment details. If the expected Timely structure cannot be parsed, it throws an explicit error instead of silently producing a questionable client record.

Unknown services do not trigger client contact. They are classified as `MANUAL_REVIEW` until Hera adds an exact/configured rule.

## Tested Timely formats

Fixtures are anonymised but structurally modeled on real Hera Timely emails observed on 17 Aug 2026:

- confirmed curly haircut
- confirmed full-head highlights
- confirmed non-bleach balayage/highlights/full-colour service
- changed curly appointment including old and new time
- cancelled curly appointment with cancellation reason

## Run

```bash
npm test
npm run demo
```

No third-party runtime packages are required for this Stage 1 parser.

## Production next step

Stage 2 should add:

1. Gmail API OAuth with `gmail.readonly`
2. Gmail polling/cursor persistence
3. Supabase/Postgres tables for booking events and pre-consult status
4. Event reconciliation logic:
   - `CONFIRMED` -> create/upsert
   - `CHANGED` -> match old appointment and update
   - `CANCELLED` -> mark cancelled and suppress contact
5. Admin-configurable exact Timely service names
6. Dry-run dashboard
7. One-click WhatsApp link only after dry-run accuracy is demonstrated

## Production matching warning

Timely notification emails expose a customer ID but not, in the samples tested so far, an explicit appointment ID. A changed event often includes the previous appointment date/time in `Recent activity`, which gives us a strong deterministic matching route. The database layer must still use conservative matching and send ambiguous cases to `NEEDS_REVIEW` rather than guessing.

## Daily Gmail ingestion policy

Locked operating schedule:

- Run daily at **10:00 Asia/Singapore**.
- Scan Timely appointment lifecycle emails received **since the last successful sync**, with a **15-minute safety overlap**.
- Deduplicate by Gmail message ID, so overlap cannot create duplicate events.
- On first run, look back **26 hours** to include the previous calendar day plus the current morning.
- Process `Appointment confirmed`, `Appointment changed`, and `Appointment cancelled` messages from `noreply@gettimely.com`.
- Exclude day-sheet messages.
- Future same-day appointments are flagged `SAME_DAY_URGENT`; past appointments are not contactable.
- System remains in **dry-run mode** until explicitly enabled for outbound messaging.


## Stage 2 Gmail ingestion worker

The project now includes a server-side worker that:

- refreshes a Google OAuth access token using a stored refresh token,
- searches Gmail with the official Gmail API for Timely confirmed/changed/cancelled messages,
- processes messages oldest-first,
- parses and classifies colour/curly services deterministically,
- ignores obvious non-target services,
- routes unknown target-domain services to manual review,
- reconciles changed/cancelled bookings,
- writes bookings, services, pre-consult state, event history and alerts to Supabase,
- saves the last successful Gmail sync checkpoint, and
- can be called from a protected Vercel Cron endpoint.

The Vercel cron expression is `0 2 * * *`, which is 10:00 AM Singapore time (UTC+8).

### Required production environment variables

See `.env.example`. Do not commit real values. Google OAuth should use the `gmail.readonly` scope.
