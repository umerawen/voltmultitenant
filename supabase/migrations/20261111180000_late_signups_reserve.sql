-- Sign-ups stay open until the tournament is settled. Only registration_open
-- feeds the draft pool; registration_closed, drafting and matches_live file the
-- player as a reserve (pool_eligible = false). Approval rules are unchanged.
create or replace function public.volt_apply(p_event uuid, p_wants_captain boolean default false)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_comm uuid; v_phase text; v_role text; v_susp int;
  v_played int; v_strikes int; v_status text; v_name text; v_evlabel text;
  v_pool boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id, phase::text into v_comm, v_phase from events where id = p_event;
  if v_comm is null then raise exception 'no such weekend'; end if;
  select role::text, suspension_remaining into v_role, v_susp from users where id = v_uid and community_id = v_comm;
  if v_role is null then raise exception 'not a member of this league'; end if;

  if v_phase = 'registration_open' then v_pool := true;
  elsif v_phase in ('registration_closed', 'drafting', 'matches_live') then v_pool := false;
  else raise exception 'registration is closed for this weekend';
  end if;

  if coalesce(v_susp,0) > 0 then raise exception 'suspended'; end if;
  if exists (select 1 from registrations where event_id = p_event and user_id = v_uid) then
    raise exception 'already applied';
  end if;
  select count(*) into v_played from registrations r join events e on e.id = r.event_id
    where r.user_id = v_uid and r.community_id = v_comm and r.status = 'approved' and e.phase = 'settled';
  v_strikes := volt_strike_count(v_uid, v_comm);
  v_status := case when v_role in ('host','moderator') then 'approved'
                   when v_played >= 2 and v_strikes = 0 then 'approved'
                   else 'pending' end;
  -- A reserve is never a captain.
  insert into registrations (event_id, community_id, user_id, status, availability_confirmed, wants_captain, pool_eligible)
  values (p_event, v_comm, v_uid, v_status, true, v_pool and coalesce(p_wants_captain,false), v_pool);

  if v_status = 'pending' then
    select display_name into v_name from users where id = v_uid and community_id = v_comm;
    select coalesce(weekend_label, 'the weekend') into v_evlabel from events where id = p_event;
    insert into notifications (community_id, user_id, event_id, kind, title, body)
    select v_comm, u.id, p_event, 'new_application',
           'New application to review',
           coalesce(v_name, 'A player') || ' applied for ' || v_evlabel
             || case when v_pool then '.' else ' as a reserve.' end
    from users u
    where u.community_id = v_comm and u.role in ('host','moderator');
  end if;

  return v_status;
end $function$;

-- Signed-in players only.
revoke execute on function public.volt_apply(uuid, boolean) from public, anon;
grant execute on function public.volt_apply(uuid, boolean) to authenticated, service_role;
