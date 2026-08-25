-- A Timely booking-change token identifies exactly one booking lifecycle.
-- Fail the migration instead of silently accepting historical collisions.
do $$
begin
  if exists (
    select 1
    from public.bookings
    where timely_change_token is not null
    group by timely_change_token
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce Timely change-token uniqueness: duplicate values exist';
  end if;
end
$$;

create unique index if not exists bookings_timely_change_token_unique
  on public.bookings (timely_change_token)
  where timely_change_token is not null;

drop index if exists public.bookings_timely_change_token_idx;
