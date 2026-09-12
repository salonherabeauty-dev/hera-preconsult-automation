-- Applied as 20260912035342. A contact hold never guesses cancellation status.
create or replace function public.hera_hold_cancellation_v2(p_event jsonb,p_message_id text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare ids uuid[]; bid uuid; old_status text; event_at timestamptz; uid text:=nullif(p_event#>>'{source,timelyBookingId}',''); tok text:=nullif(p_event#>>'{source,timelyChangeToken}','');
begin
 if p_event->>'eventType' is distinct from 'CANCELLED' then raise exception 'CANCELLATION_EVIDENCE_REQUIRED'; end if;
 select received_at into event_at from timely_events where gmail_message_id=p_message_id and event_type='cancelled';
 if not found then raise exception 'CANCELLATION_EVIDENCE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hera_atomic_timely_v2',0));
 select array_agg(b.id) into ids from bookings b where b.booking_status<>'cancelled'
 and (b.last_timely_event_at is null or b.last_timely_event_at<=event_at)
 and (uid is null or b.timely_booking_id is null or b.timely_booking_id=uid or exists(select 1 from booking_identities i where i.booking_id=b.id and i.identifier_type='ics_uid' and i.identifier_value=uid))
 and (tok is null or b.timely_change_token is null or b.timely_change_token=tok or (uid is not null and b.timely_booking_id=uid) or exists(select 1 from booking_identities i where i.booking_id=b.id and i.identifier_type='change_token' and i.identifier_value=tok))
 and b.appointment_at=(p_event#>>'{appointment,localIso}')::timestamptz and hera_canonical_service_v2(b.location_name)=hera_canonical_service_v2(p_event#>>'{appointment,locationName}') and nullif(b.location_name,'') is not null and
 ((lower(b.client_email)=lower(nullif(p_event#>>'{customer,email}',''))) or (regexp_replace(b.client_mobile,'\D','','g')=nullif(regexp_replace(p_event#>>'{customer,mobile}','\D','','g'),''))) and
 (nullif(p_event#>>'{customer,email}','') is null or b.client_email is null or lower(b.client_email)=lower(p_event#>>'{customer,email}')) and
 (nullif(p_event#>>'{customer,mobile}','') is null or b.client_mobile is null or regexp_replace(b.client_mobile,'\D','','g')=regexp_replace(p_event#>>'{customer,mobile}','\D','','g'));
 if coalesce(array_length(ids,1),0)<>1 then return jsonb_build_object('held',false,'reason','No unique non-stale identity-compatible contact/time/location candidate'); end if;
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
notify pgrst,'reload schema';
