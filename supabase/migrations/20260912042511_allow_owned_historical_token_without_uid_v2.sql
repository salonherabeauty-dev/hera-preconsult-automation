-- A cancellation may carry only an owned historical token. Resolve its owner without rotating the current token backwards.
do $migration$
declare definition text; old_guard text; new_guard text;
begin
 definition:=pg_get_functiondef('public.hera_apply_lifecycle_v2(jsonb)'::regprocedure);
 old_guard:=$old$    if v_uid is null or v_uid<>v_old.timely_booking_id then raise exception 'IDENTIFIER_CONFLICT:TOKEN_ROTATION_REQUIRES_SAME_VERIFIED_UID'; end if; v_rotation:=not v_stale;$old$;
 new_guard:=$new$    if v_uid is null then
      if not exists(select 1 from booking_identities where booking_id=v_id and identifier_type='change_token' and identifier_value=v_token) then raise exception 'IDENTIFIER_CONFLICT:TOKEN_ROTATION_REQUIRES_SAME_VERIFIED_UID'; end if;
      v_token_alias_only:=true;
    else
      if v_uid<>v_old.timely_booking_id then raise exception 'IDENTIFIER_CONFLICT:TOKEN_ROTATION_REQUIRES_SAME_VERIFIED_UID'; end if;
      v_rotation:=not v_stale;
    end if;$new$;
 if strpos(definition,old_guard)=0 or strpos(definition,'v_rotation boolean := false;')=0 or strpos(definition,'timely_change_token=case when v_stale then')=0 then raise exception 'ATOMIC_RPC_SOURCE_CHANGED_REVIEW_REQUIRED'; end if;
 definition:=replace(definition,'v_rotation boolean := false;','v_token_alias_only boolean := false; v_rotation boolean := false;');
 definition:=replace(definition,old_guard,new_guard);
 definition:=replace(definition,'timely_change_token=case when v_stale then','timely_change_token=case when v_stale or v_token_alias_only then');
 definition:=replace(definition,'when v_rotation then ''ICS_UID_VERIFIED_TOKEN_ROTATED''','when v_token_alias_only then ''CHANGE_TOKEN_ALIAS_VERIFIED'' when v_rotation then ''ICS_UID_VERIFIED_TOKEN_ROTATED''');
 execute definition;
end $migration$;
revoke all on function public.hera_apply_lifecycle_v2(jsonb) from public,anon,authenticated;
grant execute on function public.hera_apply_lifecycle_v2(jsonb) to service_role;
notify pgrst,'reload schema';
