-- Hera Pre-Consult production hardening — 2026-08-18
-- Backwards-compatible: all new booking metadata is nullable and old code keeps working.

alter table public.bookings add column if not exists timely_booking_id text;
alter table public.bookings add column if not exists booked_at timestamptz;
alter table public.bookings add column if not exists last_changed_at timestamptz;
alter table public.bookings add column if not exists cancelled_at timestamptz;
alter table public.bookings add column if not exists last_timely_event_at timestamptz;

alter table public.timely_events add column if not exists timely_booking_id text;

create unique index if not exists bookings_timely_booking_id_unique
  on public.bookings (timely_booking_id)
  where timely_booking_id is not null;
create index if not exists bookings_booked_at_idx on public.bookings (booked_at desc);
create index if not exists bookings_last_timely_event_at_idx on public.bookings (last_timely_event_at desc);

-- Recover truthful lifecycle timestamps for bookings already ingested. We only
-- derive booked_at from an actual CONFIRMED Timely event; we never invent it.
with first_confirmed as (
  select booking_id, min(received_at) as booked_at
  from public.timely_events
  where booking_id is not null and event_type = 'confirmed' and received_at is not null
  group by booking_id
)
update public.bookings b
set booked_at = fc.booked_at
from first_confirmed fc
where b.id = fc.booking_id and b.booked_at is null;

with latest_changed as (
  select booking_id, max(received_at) as changed_at
  from public.timely_events
  where booking_id is not null and event_type = 'changed' and received_at is not null
  group by booking_id
)
update public.bookings b
set last_changed_at = lc.changed_at
from latest_changed lc
where b.id = lc.booking_id and b.last_changed_at is null;

with latest_cancelled as (
  select booking_id, max(received_at) as cancelled_at
  from public.timely_events
  where booking_id is not null and event_type = 'cancelled' and received_at is not null
  group by booking_id
)
update public.bookings b
set cancelled_at = lc.cancelled_at
from latest_cancelled lc
where b.id = lc.booking_id and b.cancelled_at is null;

with latest_event as (
  select booking_id, max(received_at) as event_at
  from public.timely_events
  where booking_id is not null and received_at is not null
  group by booking_id
)
update public.bookings b
set last_timely_event_at = le.event_at
from latest_event le
where b.id = le.booking_id and b.last_timely_event_at is null;

-- A database-backed lock prevents a dashboard manual scan and a scheduled scan
-- from processing the same Gmail window concurrently.
create table if not exists public.ingestion_locks (
  lock_key text primary key,
  lock_token uuid not null,
  locked_at timestamptz not null default now()
);

alter table public.ingestion_locks enable row level security;

create or replace function public.acquire_ingestion_lock(
  p_lock_key text,
  p_ttl_seconds integer default 1200
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid := gen_random_uuid();
  v_rows integer := 0;
begin
  if p_lock_key is null or btrim(p_lock_key) = '' then
    raise exception 'LOCK_KEY_REQUIRED';
  end if;

  insert into public.ingestion_locks(lock_key, lock_token, locked_at)
  values (p_lock_key, v_token, now())
  on conflict (lock_key) do update
    set lock_token = excluded.lock_token,
        locked_at = excluded.locked_at
    where public.ingestion_locks.locked_at < now() - make_interval(secs => greatest(p_ttl_seconds, 60));

  get diagnostics v_rows = row_count;
  if v_rows = 1 then return v_token; end if;
  return null;
end;
$$;

create or replace function public.release_ingestion_lock(
  p_lock_key text,
  p_lock_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.ingestion_locks
  where lock_key = p_lock_key and lock_token = p_lock_token;
  return found;
end;
$$;

revoke all on function public.acquire_ingestion_lock(text, integer) from public;
revoke all on function public.release_ingestion_lock(text, uuid) from public;
grant execute on function public.acquire_ingestion_lock(text, integer) to service_role;
grant execute on function public.release_ingestion_lock(text, uuid) to service_role;
