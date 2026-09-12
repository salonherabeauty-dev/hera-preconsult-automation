-- Applied as 20260912033211. Contact-hold constraints are tightened by the next migration.
create or replace function public.hera_canonical_service_v2(p_text text)
returns text language sql immutable security invoker set search_path=public,pg_temp as $$
 select lower(btrim(regexp_replace(translate(replace(replace(normalize(coalesce(p_text,''),NFKC),'’',''''),'‘',''''),'‐‑‒–—―−','-------'),'\s+',' ','g')))
$$;
revoke all on function public.hera_canonical_service_v2(text) from public,anon,authenticated;
grant execute on function public.hera_canonical_service_v2(text) to service_role;
create or replace function public.hera_lifecycle_candidates_v2(p_event jsonb)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object(
 'id',b.id,'timelyCustomerId',b.timely_customer_id,'timelyBookingId',b.timely_booking_id,'timelyChangeToken',b.timely_change_token,
 'mobile',b.client_mobile,'email',b.client_email,'appointmentLocalIso',b.appointment_at,'locationName',b.location_name,
 'lastTimelyEventAt',b.last_timely_event_at,'status',case when b.booking_status='cancelled' then 'CANCELLED' else 'CONFIRMED' end,
 'serviceNames',coalesce((select jsonb_agg(s.service_name order by case when s.service_time ~* '^\d{1,2}:\d{2}(AM|PM)$' then s.service_time::time end,s.created_at,s.id) from booking_services s where s.booking_id=b.id),'[]'),
 'serviceDetails',coalesce((select jsonb_agg(jsonb_build_object('serviceName',s.service_name,'staffName',s.staff_name,'serviceTime',s.service_time) order by case when s.service_time ~* '^\d{1,2}:\d{2}(AM|PM)$' then s.service_time::time end,s.created_at,s.id) from booking_services s where s.booking_id=b.id),'[]'),
 'identityAliases',coalesce((select jsonb_agg(jsonb_build_object('identifierType',i.identifier_type,'identifierValue',i.identifier_value)) from booking_identities i where i.booking_id=b.id),'[]')
 ) order by b.id),'[]') from bookings b where
 b.timely_booking_id=nullif(p_event#>>'{source,timelyBookingId}','') or b.timely_change_token=nullif(p_event#>>'{source,timelyChangeToken}','') or
 b.timely_booking_id=nullif(p_event#>>'{source,timelyChangeToken}','') or
 b.timely_customer_id=nullif(p_event#>>'{customer,timelyCustomerId}','') or
 lower(b.client_email)=lower(nullif(p_event#>>'{customer,email}','')) or
 regexp_replace(b.client_mobile,'\D','','g')=nullif(regexp_replace(p_event#>>'{customer,mobile}','\D','','g'),'') or
 exists(select 1 from booking_identities i where i.booking_id=b.id and ((i.identifier_type='ics_uid' and i.identifier_value=p_event#>>'{source,timelyBookingId}') or (i.identifier_type='change_token' and i.identifier_value=p_event#>>'{source,timelyChangeToken}')))
$$;
revoke all on function public.hera_lifecycle_candidates_v2(jsonb) from public,anon,authenticated;
grant execute on function public.hera_lifecycle_candidates_v2(jsonb) to service_role;
create or replace function public.hera_hold_cancellation_v2(p_event jsonb,p_message_id text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare ids uuid[]; bid uuid; old_status text;
begin
 if p_event->>'eventType' is distinct from 'CANCELLED' or not exists(select 1 from timely_events where gmail_message_id=p_message_id and event_type='cancelled') then raise exception 'CANCELLATION_EVIDENCE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hera_atomic_timely_v2',0));
 select array_agg(b.id) into ids from bookings b where b.booking_status<>'cancelled' and b.appointment_at=(p_event#>>'{appointment,localIso}')::timestamptz and hera_canonical_service_v2(b.location_name)=hera_canonical_service_v2(p_event#>>'{appointment,locationName}') and nullif(b.location_name,'') is not null and
 ((lower(b.client_email)=lower(nullif(p_event#>>'{customer,email}',''))) or (regexp_replace(b.client_mobile,'\D','','g')=nullif(regexp_replace(p_event#>>'{customer,mobile}','\D','','g'),''))) and
 (nullif(p_event#>>'{customer,email}','') is null or b.client_email is null or lower(b.client_email)=lower(p_event#>>'{customer,email}')) and
 (nullif(p_event#>>'{customer,mobile}','') is null or b.client_mobile is null or regexp_replace(b.client_mobile,'\D','','g')=regexp_replace(p_event#>>'{customer,mobile}','\D','','g'));
 if coalesce(array_length(ids,1),0)<>1 then return jsonb_build_object('held',false,'reason','No unique contact/time/location candidate'); end if;
 bid:=ids[1];
 select workflow_status into old_status from preconsult_status where booking_id=bid for update;
 if old_status in ('to_contact','sent','awaiting_photos','photos_received') then
  update preconsult_status set workflow_status='manual_review',staff_notes=concat_ws(E'\n',staff_notes,'CONTACT HOLD: Timely cancellation requires reconciliation; verify in Timely before contacting. Message '||p_message_id) where booking_id=bid;
  insert into audit_logs(booking_id,action,details) values(bid,'ambiguous_cancellation_contact_hold',jsonb_build_object('gmail_message_id',p_message_id,'previous_workflow_status',old_status,'booking_status_unchanged',true));
 end if;
 return jsonb_build_object('held',true,'bookingId',bid,'reason','Contact held, not guessed cancelled');
end $$;
revoke all on function public.hera_hold_cancellation_v2(jsonb,text) from public,anon,authenticated;
grant execute on function public.hera_hold_cancellation_v2(jsonb,text) to service_role;
create or replace function public.hera_record_alert_v2(p_alert jsonb)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare aid uuid; ctx jsonb:=coalesce(p_alert->'context','{}'); k text:=p_alert->>'dedupeKey'; typ text:=p_alert->>'alertType'; svc text;
begin
 perform pg_advisory_xact_lock(hashtextextended('hera_alert_dedupe_v2',0));
 svc:=ctx->>'serviceName';
 select id into aid from system_alerts a where a.resolved_at is null and (
 (k is not null and a.context->>'dedupe_key'=k) or
 (typ in ('unknown_target_service','unknown_service_in_qualifying_booking') and svc is not null and a.alert_type in ('unknown_target_service','unknown_service_in_qualifying_booking') and exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(a.context->'services')='array' then a.context->'services' else '[]'::jsonb end) s where hera_canonical_service_v2(s)=hera_canonical_service_v2(svc)))
 ) order by a.created_at limit 1 for update;
 if aid is not null then
  update system_alerts set context=coalesce(context,'{}')||jsonb_build_object('dedupe_key',k,'last_seen_at',now(),'latest_occurrence',ctx) where id=aid;
 else
  insert into system_alerts(severity,alert_type,message,context) values(p_alert->>'severity',typ,p_alert->>'message',ctx||jsonb_build_object('dedupe_key',k,'last_seen_at',now())) returning id into aid;
 end if;
 return aid;
end $$;
revoke all on function public.hera_record_alert_v2(jsonb) from public,anon,authenticated;
grant execute on function public.hera_record_alert_v2(jsonb) to service_role;
create or replace function public.hera_event_state_v2(p_message_id text)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare e timely_events%rowtype; b bookings%rowtype; p preconsult_status%rowtype; valid boolean;
begin
 select * into e from timely_events where gmail_message_id=p_message_id;
 if not found then return jsonb_build_object('exists',false,'processed',false); end if;
 if e.processed_at is null or e.parse_status not in ('parsed','ignored','manual_review') then return jsonb_build_object('exists',true,'processed',false); end if;
 if e.parse_status in ('ignored','manual_review') then return jsonb_build_object('exists',true,'processed',true); end if;
 select * into b from bookings where id=e.booking_id;
 if not found then return jsonb_build_object('exists',true,'processed',false); end if;
 select * into p from preconsult_status where booking_id=b.id;
 if not found then return jsonb_build_object('exists',true,'processed',false); end if;
 valid := (b.booking_status<>'cancelled' or p.workflow_status='blocked_cancelled') and
 (not exists(select 1 from booking_services s where s.booking_id=b.id and s.preconsult_required) or p.required or b.booking_status='cancelled');
 if b.booking_status<>'cancelled' then
  valid:=valid and exists(select 1 from booking_services s where s.booking_id=b.id);
  if b.latest_gmail_message_id=e.gmail_message_id and jsonb_typeof(e.services)='array' then
   valid:=valid and (select count(*) from booking_services s where s.booking_id=b.id)=jsonb_array_length(e.services);
  end if;
 end if;
 return jsonb_build_object('exists',true,'processed',valid);
end $$;
revoke all on function public.hera_event_state_v2(text) from public,anon,authenticated;
grant execute on function public.hera_event_state_v2(text) to service_role;
notify pgrst,'reload schema';
