-- IMPORTANT — HISTORICAL BOOTSTRAP REFERENCE ONLY
-- This file describes an earlier project stage and is NOT authoritative for the
-- current Hera production database. Do NOT run it against production. Current
-- production DDL changes are managed through supabase/migrations/ and validated
-- against the live Supabase schema before release. See the root README.md.
--
-- Hera Hair Beauty Pre-Consult Automation
-- Stage 2 production schema (PostgreSQL / Supabase)

create extension if not exists pgcrypto;

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  timely_customer_id text unique,
  first_name text,
  last_name text,
  display_name text not null,
  email text,
  mobile_e164 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  appointment_at timestamptz not null,
  appointment_timezone text not null default 'Asia/Singapore',
  location_name text,
  services jsonb not null default '[]'::jsonb,
  status text not null check (status in ('CONFIRMED','CANCELLED','NEEDS_REVIEW')),
  booking_fingerprint text,
  last_timely_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookings_client_time_idx on bookings(client_id, appointment_at);
create index if not exists bookings_status_idx on bookings(status);
create unique index if not exists bookings_fingerprint_unique on bookings(booking_fingerprint) where booking_fingerprint is not null;

create table if not exists booking_events (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,
  parser_version text not null,
  event_type text not null check (event_type in ('CONFIRMED','CHANGED','CANCELLED')),
  timely_customer_id text,
  booking_id uuid references bookings(id),
  subject text not null,
  raw_event jsonb not null,
  processing_status text not null check (processing_status in ('PROCESSED','NEEDS_REVIEW','ERROR')),
  processing_error text,
  received_at timestamptz not null,
  processed_at timestamptz not null default now()
);

create table if not exists service_rules (
  id uuid primary key default gen_random_uuid(),
  exact_service_name text unique,
  rule_key text not null,
  category text not null,
  preconsult_required boolean not null default false,
  active boolean not null default true,
  priority integer not null default 100,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists preconsultations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id),
  status text not null check (status in (
    'READY_TO_CONTACT','MESSAGE_SENT','AWAITING_CLIENT','PHOTOS_PARTIAL',
    'PHOTOS_COMPLETE','COMPLETE','SKIPPED','CANCELLED','NEEDS_REVIEW'
  )),
  template_key text,
  sent_at timestamptz,
  sent_by text,
  current_photos_received boolean not null default false,
  inspiration_photos_received boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_events (
  id bigint generated always as identity primary key,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  actor_type text not null default 'SYSTEM',
  actor_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_entity_idx on audit_events(entity_type, entity_id, created_at desc);

-- Production recommendation: enable RLS before exposing any table to a browser client.
-- Server-only ingestion should use a server-side service role secret, never a browser-exposed key.

-- Dashboard maintenance-state extension (production migration 2026-08-17)
-- Existing production table preconsult_status uses these fields to close a pre-consult
-- when a client confirms they are simply maintaining their usual Hera look.
-- alter table public.preconsult_status add column if not exists maintenance_confirmed boolean not null default false;
-- alter table public.preconsult_status add column if not exists maintenance_confirmed_at timestamptz null;
