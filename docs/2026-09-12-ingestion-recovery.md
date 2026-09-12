# Timely ingestion recovery — 12 September 2026

## Scope and safety

The recovery release uses `dailySyncV2`, `workerV2`, `reconcileV2` and `AtomicSupabaseRepository` behind the existing authenticated cron and dashboard routes. The established parser, dashboard design, human-reviewed draft workflow and Google OAuth environment names are retained. No automatic client communication is introduced.

Apply database migrations in timestamp order before deploying the V2 worker on a fresh environment. The three migration filenames match the production migration-history versions. The `hera_*_v2` RPCs are security-invoker functions restricted to `service_role`; they must not be granted to browser roles. Production repair snapshots and client-specific reconciliation evidence remain in restricted database storage/audit logs, not this public repository.

## Guarantees and limits

- Atomic lifecycle RPC commits the booking, its entire service block, workflow, identity aliases, terminal event and audit together.
- Repeated response-loss retries are idempotent. Event completion checks require linked workflow/service coverage, not merely a Gmail ID row.
- A same-UID change-token rotation may retain historical aliases when no other booking owns the incoming token. Conflicting owners and cancelled-booking resurrection remain blocked.
- A distinct verified UID/token is not merged into an old cancelled booking by client name or appointment similarity.
- Smoothing/keratin/smoothening variants without an approved exact rule go to manual review, not automatic inclusion or exclusion.
- Unknown add-ons do not suppress another service that qualifies the booking.
- Ambiguous cancellation contact holds are not cancellation decisions. Resolve them using authoritative booking evidence and audit the decision.
- Bounded transport retries can recover transient gateway failures but cannot guarantee availability during a persistent provider outage.

## Contact-hold build safeguard

`npm run build` automatically runs `scripts/enforce-contact-review.mjs` through the `prebuild` hook. It adds narrowly scoped safeguards to the preserved dashboard source before TypeScript compilation and Vercel deployment. Each source anchor must match exactly once; unexpected upstream changes fail the build instead of silently omitting a safeguard. The transformation is idempotent. Do not bypass `npm run build` when deploying.

The generated dashboard puts held records in **Needs Review**, removes them from the contact queue, blocks contact actions, and rechecks current server data before opening a WhatsApp draft. The generated workflow API returns HTTP 409 for held records except staff-note updates. Regression tests execute the guarded JavaScript with synthetic data; they do not send messages or open real client windows. If the base UI changes, update the transformation and tests deliberately or fold the safeguards into its source and remove the build transform in one tested release.

## Verification

Run `npm test`; it runs both TypeScript builds, all regression tests and dashboard syntax validation. Verify actual Production `/api/cron` success and `sync_state.gmail_last_successful_sync` with `source=PRIMARY_VERCEL_WORKER` and `workerVersion=ATOMIC_V2`. READY deployment status alone is insufficient. Compare every lifecycle Gmail ID inside the completed cutoff window and check for processing/error rows, missing workflows, ownership conflicts and unguarded cancellations.

A passive connector audit heartbeat is not an ingestion checkpoint. A controlled interactive connector recovery is not proof of unattended failover. Keep source, execution mode, tested coverage and pending verification explicit.

## Operations

Do not rotate Google credentials for a Supabase 504. Investigate provider health, failed request routes and database blocking. A project restart is an owner-side recovery option when supported by current Supabase guidance; never substitute Pause/Delete/Reset. Do not force a live ingestion lease or falsely advance a successful checkpoint.

For rollback, use the last known-good deployment while retaining the additive database RPC migrations and immutable audit history. Do not restore an old data snapshot over newer client activity without a separately reviewed reconciliation plan.
