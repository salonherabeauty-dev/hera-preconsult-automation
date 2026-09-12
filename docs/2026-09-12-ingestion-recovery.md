# Timely ingestion recovery — 12 September 2026

## Scope and safety

The recovery release uses `dailySyncV2`, `workerV2`, `reconcileV2` and `AtomicSupabaseRepository` behind the existing authenticated cron and dashboard routes. The established parser, dashboard design, human-reviewed draft workflow and Google OAuth environment names are retained. No automatic client communication is introduced.

Apply database migrations in timestamp order before deploying the V2 worker on a fresh environment. The migration filenames match the production migration-history versions. The `hera_*_v2` RPCs are security-invoker functions restricted to `service_role`; they must not be granted to browser roles. Production repair snapshots and client-specific reconciliation evidence remain in restricted database storage/audit logs, not this public repository.

## Guarantees and limits

- Atomic lifecycle RPC commits the booking, its entire service block, workflow, identity aliases, terminal event and audit together.
- Repeated response-loss retries are idempotent. Completion checks require linked workflow/service coverage, not merely a Gmail ID row.
- Same-UID token rotation retains historical aliases when no other booking owns the incoming token. A token-only cancellation can use an already-owned historical alias without replacing the current token. Conflicting owners and cancelled-booking resurrection remain blocked.
- Distinct verified UID/token pairs are not merged into old cancelled bookings by name or appointment similarity.
- Smoothing/keratin/smoothening variants without approved exact rules go to manual review, not automatic inclusion or exclusion.
- Unknown add-ons do not suppress another service that qualifies the booking.
- Ambiguous cancellation contact holds are not cancellation decisions. Resolve them using authoritative booking evidence and audit the decision.
- Bounded retries can recover transient gateway failures but cannot guarantee availability during persistent provider outages.

## Contact-hold build safeguard

`npm run build` runs `scripts/enforce-contact-review.mjs` through the `prebuild` hook. It adds narrow safeguards to the preserved dashboard source before TypeScript compilation and Vercel deployment. Each source anchor must match exactly once; unexpected upstream changes fail the build instead of silently omitting protection. The transformation is idempotent. Do not bypass `npm run build` when deploying.

The generated dashboard puts held records in **Needs Review**, removes them from the contact queue, blocks contact actions and rechecks live server data before opening a WhatsApp draft. The generated workflow API returns HTTP 409 for held records except staff-note updates. Synthetic regression tests do not send messages or open real client windows. If the base UI changes, update the transformation and tests deliberately or incorporate the safeguards directly into source and remove the transform in one tested release.

## Verification

Run `npm test` for both TypeScript builds, all regression tests and dashboard syntax validation. Verify actual Production `/api/cron` success and `sync_state.gmail_last_successful_sync` with `source=PRIMARY_VERCEL_WORKER` and `workerVersion=ATOMIC_V2`. READY status alone is insufficient. Compare every lifecycle Gmail ID in the cutoff window and check processing/error rows, missing workflows, ownership conflicts and unguarded cancellations.

Production SQL was additionally tested inside rolled-back transactions: original confirmation partial-save recovery, repeated application, all historical rotation repairs, token-only historical-alias cancellation, current-token preservation, unowned-token rejection, cross-booking ownership rejection and refusal to advance a checkpoint past missing messages. No rollback-test records are retained.

A passive connector heartbeat is not an ingestion checkpoint. Controlled interactive recovery is not proof of unattended failover. Keep source, execution mode, tested coverage and pending verification explicit.

## Operations and rollback

Do not rotate Google credentials for a Supabase 504. Investigate provider health, failed request routes and database blocking. A project restart is an owner-side recovery option when supported by current Supabase guidance; never substitute Pause/Delete/Reset. Do not force a live ingestion lease or falsely advance a checkpoint.

For rollback, use the last known-good deployment while retaining the additive database RPC migrations and immutable audit history. Do not restore an old data snapshot over newer activity without a separately reviewed reconciliation plan.
