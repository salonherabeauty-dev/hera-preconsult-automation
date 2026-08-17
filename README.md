# Hera Pre-Consult Automation + Command Centre

Production worker and private GUI for Hera Hair Beauty.

## What it does

- Reads Timely lifecycle emails from Gmail through the official Gmail API.
- Deterministically classifies qualifying Colour, Highlights, Balayage and Curly services.
- Stores lifecycle state in Supabase and fails closed on ambiguous formats.
- Runs daily at 10:00 AM Singapore time via Vercel Cron.
- Provides a private, live Pre-Consult Command Centre at the Vercel project root.
- Creates smart 48-hour WhatsApp priorities without sending any message automatically.
- Opens a pre-filled WhatsApp conversation, then lets staff explicitly mark it sent.
- Tracks current photos, inspiration photos, staff notes, completion and skipped/cancelled states.
- Includes a protected "Scan Gmail now" action for an immediate manual scan.

## Required Vercel environment variables

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `CRON_SECRET`
- `DASHBOARD_PASSWORD` (new: choose a strong private password for the GUI)

All secrets stay server-side. The browser never receives the Supabase secret key, Google OAuth credentials or cron secret.

## GUI workflow

1. Sign in with the dashboard password.
2. Review the Smart Briefing and Action Queue.
3. Start Smart Queue to process unsent qualifying clients in urgency order.
4. Review/edit the category-aware pre-consult message.
5. Click **Open WhatsApp** to open a pre-filled `wa.me` message.
6. After the staff member sends it in WhatsApp, click **Mark sent & next**.
7. Tick current/inspiration photos when received and add internal notes.
8. Complete the pre-consult when the stylist has what they need.

## Safety

- No outbound WhatsApp, SMS or email is sent automatically.
- Cancelled appointments are blocked.
- Non-target services are ignored before reconciliation.
- `DASHBOARD_PASSWORD` protects the GUI with an HttpOnly, SameSite=Strict session cookie.
- Do not commit `.env` or real secret values to GitHub.

## Commands

```bash
npm install
npm test
npm run demo
```
