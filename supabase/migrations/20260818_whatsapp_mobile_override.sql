-- Hera Pre-Consult WhatsApp number override — 2026-08-18
-- Stores a verified dashboard-only WhatsApp destination without mutating Timely data.

alter table public.preconsult_status
  add column if not exists whatsapp_mobile_override text;

alter table public.preconsult_status
  add column if not exists whatsapp_mobile_override_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'preconsult_status_whatsapp_override_e164'
      and conrelid = 'public.preconsult_status'::regclass
  ) then
    alter table public.preconsult_status
      add constraint preconsult_status_whatsapp_override_e164
      check (whatsapp_mobile_override is null or whatsapp_mobile_override ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;
