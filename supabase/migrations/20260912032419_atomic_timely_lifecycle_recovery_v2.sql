-- Applied as 20260912032419 on 2026-09-12. Server-only atomic recovery RPCs.
create or replace function public.hera_apply_lifecycle_v2(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  m jsonb := p_input->'message'; e jsonb := p_input->'event'; p jsonb := p_input->'plan';
  cs jsonb := p_input->'classifications'; s jsonb; c jsonb; v_old public.bookings%rowtype;
  v_event public.timely_events%rowtype; v_id uuid; v_ids uuid[]; v_other uuid;
  v_uid text := nullif(e#>>'{source,timelyBookingId}','');
  v_token text := nullif(e#>>'{source,timelyChangeToken}','');
  v_mid text := m->>'id'; v_type text := lower(e->>'eventType'); v_action text := p->>'action';
  v_received timestamptz := (m->>'receivedAt')::timestamptz;
  v_appointment timestamptz := (e#>>'{appointment,localIso}')::timestamptz;
  v_required boolean; v_category text; v_stale boolean := false; v_new boolean := false;
  v_rotation boolean := false; v_kind text; v_value text; v_resolution text; v_workflow text;
begin
  if v_mid is null or v_received is null or v_appointment is null or v_type is null or v_action is null or v_type not in ('confirmed','changed','cancelled') or v_action not in ('CREATE','UPDATE','CANCEL','NOOP') then raise exception 'INVALID_LIFECYCLE_INPUT'; end if;
  if v_action='CANCEL' and v_type<>'cancelled' then raise exception 'CANCELLATION_SOURCE_REQUIRED'; end if;
  if jsonb_typeof(e#>'{appointment,services}') is distinct from 'array' or jsonb_array_length(e#>'{appointment,services}')=0 or jsonb_typeof(cs) is distinct from 'array' then raise exception 'COMPLETE_SERVICE_BLOCK_REQUIRED'; end if;
  if exists (select 1 from jsonb_array_elements(e#>'{appointment,services}') x where not exists(select 1 from jsonb_array_elements(cs) y where y->>'serviceName'=x->>'serviceName')) then raise exception 'SERVICE_CLASSIFICATION_MISSING'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hera_atomic_timely_v2',0));
  select * into v_event from timely_events where gmail_message_id=v_mid for update;
  if not found then raise exception 'TIMELY_EVENT_NOT_STAGED'; end if;
  if v_event.processed_at is not null and v_event.parse_status='parsed' and v_event.booking_id is not null and exists(select 1 from preconsult_status where booking_id=v_event.booking_id) then return jsonb_build_object('bookingId',v_event.booking_id,'outcome','ALREADY_COMMITTED'); end if;
  v_required := exists(select 1 from jsonb_array_elements(cs) x where (x->>'preconsultRequired')::boolean);
  select lower(x->>'category') into v_category from jsonb_array_elements(cs) x order by coalesce((x->>'preconsultRequired')::boolean,false) desc, (x->>'category'='EXCLUDED') limit 1;
  v_id := nullif(p->>'bookingId','')::uuid;
  select array_agg(distinct bid) into v_ids from (select id bid from bookings where (v_uid is not null and timely_booking_id=v_uid) or (v_token is not null and timely_change_token=v_token) union all select booking_id from booking_identities where (identifier_type='ics_uid' and identifier_value=v_uid) or (identifier_type='change_token' and identifier_value=v_token)) q;
  if coalesce(array_length(v_ids,1),0)>1 or (v_id is not null and array_length(v_ids,1)=1 and v_ids[1]<>v_id) then raise exception 'IDENTIFIER_CONFLICT: identifiers have different booking owners'; end if;
  if v_action='CREATE' and array_length(v_ids,1)=1 then v_id:=v_ids[1]; v_action:='UPDATE'; end if;
  if v_action='CREATE' then
    if v_type='cancelled' or v_appointment<now() or not v_required then raise exception 'ACTIVE_BOOKING_CREATION_NOT_PERMITTED'; end if;
    insert into bookings(timely_customer_id,timely_booking_id,timely_change_token,client_name,client_email,client_mobile,service_name,service_category,stylist_name,location_name,appointment_at,price,booking_status,latest_gmail_message_id,booked_at,last_timely_event_at,first_seen_at,last_seen_at,identity_resolution)
    values(e#>>'{customer,timelyCustomerId}',v_uid,v_token,e#>>'{customer,name}',e#>>'{customer,email}',e#>>'{customer,mobile}',e#>>'{appointment,services,0,serviceName}',v_category,e#>>'{appointment,services,0,staffName}',e#>>'{appointment,locationName}',v_appointment,nullif(e#>>'{appointment,totalPrice}','')::numeric,'confirmed',v_mid,case when v_type='confirmed' then v_received end,v_received,v_received,v_received,'ATOMIC_V2') returning id into v_id; v_new:=true;
  end if;
  if v_id is null then raise exception 'BOOKING_ID_REQUIRED'; end if;
  select * into v_old from bookings where id=v_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  v_stale := v_old.last_timely_event_at is not null and v_received<v_old.last_timely_event_at;
  if v_old.booking_status='cancelled' and v_type<>'cancelled' and not v_stale then raise exception 'IDENTIFIER_CONFLICT:CANCELLED_BOOKING_RESURRECTION_BLOCKED'; end if;
  if v_uid is not null and v_old.timely_booking_id is not null and v_uid<>v_old.timely_booking_id and not (v_old.timely_booking_id=v_token and v_old.timely_change_token is null) then raise exception 'IDENTIFIER_CONFLICT:ICS_UID_CHANGE_BLOCKED'; end if;
  if v_token is not null and v_old.timely_change_token is not null and v_token<>v_old.timely_change_token then
    if v_uid is null or v_uid<>v_old.timely_booking_id then raise exception 'IDENTIFIER_CONFLICT:TOKEN_ROTATION_REQUIRES_SAME_VERIFIED_UID'; end if; v_rotation:=not v_stale;
  end if;
  for v_kind,v_value in select * from (values ('ics_uid',case when v_old.timely_booking_id=v_token and v_old.timely_change_token is null then null else v_old.timely_booking_id end),('change_token',v_old.timely_change_token),('ics_uid',v_uid),('change_token',v_token)) z(kind,val) where val is not null loop
    select booking_id into v_other from booking_identities where identifier_type=v_kind and identifier_value=v_value;
    if found and v_other<>v_id then raise exception 'IDENTIFIER_CONFLICT:ALIAS_OWNED_BY_ANOTHER_BOOKING'; end if;
    if exists(select 1 from bookings where id<>v_id and ((v_kind='ics_uid' and timely_booking_id=v_value) or (v_kind='change_token' and timely_change_token=v_value))) then raise exception 'IDENTIFIER_CONFLICT:VALUE_OWNED_BY_ANOTHER_BOOKING'; end if;
    insert into booking_identities(booking_id,identifier_type,identifier_value,first_seen_gmail_message_id,first_seen_event_type) values(v_id,v_kind,v_value,v_mid,v_type) on conflict(identifier_type,identifier_value) do nothing;
  end loop;
  v_resolution:=case when v_stale then 'EVENT_OUT_OF_ORDER' when v_rotation then 'ICS_UID_VERIFIED_TOKEN_ROTATED' when v_uid is not null and v_token is not null then 'ICS_UID_AND_CHANGE_TOKEN_VERIFIED' when v_uid is not null then 'ICS_UID_VERIFIED' when v_token is not null then 'CHANGE_TOKEN_VERIFIED' else 'DETERMINISTIC_COMPOSITE_MATCH' end;
  update bookings set timely_booking_id=coalesce(v_uid,timely_booking_id),timely_change_token=case when v_stale then coalesce(timely_change_token,v_token) else coalesce(v_token,timely_change_token) end,booked_at=case when booked_at is null and v_type='confirmed' then v_received else booked_at end,client_email=coalesce(client_email,e#>>'{customer,email}'),client_mobile=coalesce(client_mobile,e#>>'{customer,mobile}') where id=v_id;
  if not v_stale then
    if v_type='cancelled' or v_action='CANCEL' then
      update bookings set booking_status='cancelled',cancelled_at=coalesce(cancelled_at,v_received),latest_gmail_message_id=v_mid,last_timely_event_at=v_received,last_seen_at=v_received,identity_resolution=v_resolution where id=v_id;
      insert into preconsult_status(booking_id,required,workflow_status) values(v_id,v_required,'blocked_cancelled') on conflict(booking_id) do update set workflow_status='blocked_cancelled';
    else
      update bookings set timely_customer_id=coalesce(e#>>'{customer,timelyCustomerId}',timely_customer_id),client_name=e#>>'{customer,name}',client_email=coalesce(e#>>'{customer,email}',client_email),client_mobile=coalesce(e#>>'{customer,mobile}',client_mobile),appointment_at=v_appointment,service_name=e#>>'{appointment,services,0,serviceName}',service_category=v_category,stylist_name=e#>>'{appointment,services,0,staffName}',location_name=e#>>'{appointment,locationName}',price=coalesce(nullif(e#>>'{appointment,totalPrice}','')::numeric,price),booking_status=case when v_type='changed' then 'changed' else 'confirmed' end,latest_gmail_message_id=v_mid,last_changed_at=case when v_type='changed' then v_received else last_changed_at end,last_timely_event_at=v_received,last_seen_at=v_received,identity_resolution=v_resolution where id=v_id;
      delete from booking_services where booking_id=v_id;
      for s in select value from jsonb_array_elements(e#>'{appointment,services}') loop
        select value into c from jsonb_array_elements(cs) where value->>'serviceName'=s->>'serviceName' limit 1;
        insert into booking_services(booking_id,service_name,staff_name,service_time,category,preconsult_required,matched_rule_id,classification_confidence) values(v_id,s->>'serviceName',s->>'staffName',s->>'serviceTime',lower(c->>'category'),(c->>'preconsultRequired')::boolean,c->>'matchedRuleId',c->>'confidence');
      end loop;
      v_workflow:=case when not v_required then 'not_required' when v_appointment<now() then 'skipped' else 'to_contact' end;
      insert into preconsult_status(booking_id,required,workflow_status,staff_notes) values(v_id,v_required,v_workflow,case when p_input->>'timing'='SAME_DAY_URGENT' then 'Same-day booking recovered by verified Timely ingestion.' end)
      on conflict(booking_id) do update set required=excluded.required,workflow_status=case when not excluded.required then 'not_required' when not preconsult_status.required or preconsult_status.workflow_status='not_required' then excluded.workflow_status else preconsult_status.workflow_status end;
    end if;
  end if;
  if (select booking_status from bookings where id=v_id)='cancelled' then
    insert into preconsult_status(booking_id,required,workflow_status) values(v_id,v_required,'blocked_cancelled') on conflict(booking_id) do update set workflow_status='blocked_cancelled';
  elsif not exists(select 1 from preconsult_status where booking_id=v_id) then raise exception 'PRECONSULT_STATUS_MISSING_REQUIRES_LATEST_EVENT_REPLAY'; end if;
  update timely_events set booking_id=v_id,parse_status='parsed',parse_error=null,processed_at=now(),identity_resolution=v_resolution where gmail_message_id=v_mid;
  insert into audit_logs(booking_id,action,details) values(v_id,'atomic_timely_lifecycle_v2',jsonb_build_object('gmail_message_id',v_mid,'event_type',v_type,'action',v_action,'source',coalesce(p_input->>'source','PRIMARY_VERCEL_WORKER'),'stale_noop',v_stale,'token_rotated',v_rotation,'previous_change_token',v_old.timely_change_token,'new_change_token',v_token,'before',case when v_new then null else to_jsonb(v_old) end));
  update system_alerts set resolved_at=now(),context=coalesce(context,'{}')||jsonb_build_object('resolution','Verified atomic lifecycle replay committed','resolved_booking_id',v_id,'resolved_message_id',v_mid) where resolved_at is null and alert_type in ('identifier_conflict','booking_reconciliation_review','gmail_ingestion_message_failure','timely_parse_error') and (context->>'gmailMessageId'=v_mid or context->>'gmail_message_id'=v_mid or message like '%'||v_mid||'%');
  return jsonb_build_object('bookingId',v_id,'outcome',case when v_stale then 'EVENT_OUT_OF_ORDER: state preserved' when v_rotation then 'VERIFIED_UID_TOKEN_ROTATION_APPLIED' else coalesce(p->>'reason','ATOMIC_LIFECYCLE_APPLIED') end);
end $$;
revoke all on function public.hera_apply_lifecycle_v2(jsonb) from public,anon,authenticated;
grant execute on function public.hera_apply_lifecycle_v2(jsonb) to service_role;
create or replace function public.hera_acquire_ingestion_lock_v2(p_lock_key text,p_lock_token uuid,p_ttl_seconds integer default 1200)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_lock_key<>'gmail_timely_ingestion' or p_lock_token is null then raise exception 'INVALID_INGESTION_LEASE'; end if;
 insert into ingestion_locks(lock_key,lock_token,locked_at) values(p_lock_key,p_lock_token,now()) on conflict(lock_key) do update set lock_token=excluded.lock_token,locked_at=excluded.locked_at where ingestion_locks.lock_token=p_lock_token or ingestion_locks.locked_at<now()-make_interval(secs=>greatest(p_ttl_seconds,60));
 if found then return p_lock_token; end if; return null;
end $$;
revoke all on function public.hera_acquire_ingestion_lock_v2(text,uuid,integer) from public,anon,authenticated;
grant execute on function public.hera_acquire_ingestion_lock_v2(text,uuid,integer) to service_role;
create or replace function public.hera_complete_sync_v2(p_value jsonb,p_message_ids text[])
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if exists(select 1 from unnest(p_message_ids) mid left join timely_events e on e.gmail_message_id=mid where e.id is null or e.processed_at is null or e.parse_status not in ('parsed','ignored','manual_review')) then raise exception 'GMAIL_SYNC_INCOMPLETE:WINDOW_HAS_UNFINISHED_MESSAGES'; end if;
 if exists(select 1 from timely_events e join bookings b on b.id=e.booking_id left join preconsult_status p on p.booking_id=b.id where e.gmail_message_id=any(p_message_ids) and (p.id is null or (b.booking_status='cancelled' and p.workflow_status<>'blocked_cancelled') or (b.booking_status<>'cancelled' and exists(select 1 from booking_services s where s.booking_id=b.id and s.preconsult_required) and not p.required))) then raise exception 'GMAIL_SYNC_INCOMPLETE:LINKED_WORKFLOW_INVARIANT'; end if;
 insert into sync_state(key,value) values('gmail_last_successful_sync',p_value) on conflict(key) do update set value=excluded.value where (sync_state.value->>'at')::timestamptz<=(excluded.value->>'at')::timestamptz;
 return true;
end $$;
revoke all on function public.hera_complete_sync_v2(jsonb,text[]) from public,anon,authenticated;
grant execute on function public.hera_complete_sync_v2(jsonb,text[]) to service_role;
notify pgrst,'reload schema';
