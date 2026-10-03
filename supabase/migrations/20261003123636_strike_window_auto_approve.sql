-- Auto-approval counted every no-show a player ever had, while suspensions
-- only count strikes from the last 90 days (volt_strike_count). So a single
-- old, expired strike blocked auto-approval forever. Both sign-up paths now
-- use the same rolling window.

CREATE OR REPLACE FUNCTION public.volt_apply(p_event uuid, p_wants_captain boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Open = you're in the draft. Closed = you can still sign up, but as a reserve
  -- (the auction pool is locked). Past that the weekend is underway.
  if v_phase = 'registration_open' then v_pool := true;
  elsif v_phase = 'registration_closed' then v_pool := false;
  else raise exception 'registration is closed for this weekend';
  end if;

  if coalesce(v_susp,0) > 0 then raise exception 'suspended'; end if;
  if exists (select 1 from registrations where event_id = p_event and user_id = v_uid) then
    raise exception 'already applied';
  end if;
  select count(*) into v_played from registrations r join events e on e.id = r.event_id
    where r.user_id = v_uid and r.community_id = v_comm and r.status = 'approved' and e.phase = 'settled';
  v_strikes := volt_strike_count(v_uid, v_comm);   -- rolling 90 days, same as suspensions
  v_status := case when v_role in ('host','moderator') then 'approved'
                   when v_played >= 2 and v_strikes = 0 then 'approved'
                   else 'pending' end;
  insert into registrations (event_id, community_id, user_id, status, availability_confirmed, wants_captain, pool_eligible)
  values (p_event, v_comm, v_uid, v_status, true, coalesce(p_wants_captain,false), v_pool);

  if v_status = 'pending' then
    select display_name into v_name from users where id = v_uid;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_register(p_guild text DEFAULT NULL::text, p_discord_id text DEFAULT NULL::text, p_captain boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_ev record; v_pool boolean; v_status text;
        v_played int; v_strikes int; v_susp int;
        v_league jsonb; v_missing text[] := '{}'; pp record; pc record;
begin
  v_league := volt_dc_league(p_guild);

  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then
    return jsonb_build_object('error','link', 'league', v_league);
  end if;

  select id, phase::text as phase, weekend_label into v_ev
    from events where community_id = v.community_id and phase in ('registration_open','registration_closed')
    order by starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('error','closed'); end if;

  select suspension_remaining into v_susp from users where id = v.user_id;
  if coalesce(v_susp,0) > 0 then return jsonb_build_object('error','suspended','n',v_susp); end if;
  if exists (select 1 from registrations where event_id = v_ev.id and user_id = v.user_id) then
    return jsonb_build_object('error','already'); end if;

  select rank, role into pp from player_profiles
   where user_id = v.user_id and community_id = v.community_id;
  select whatsapp into pc from player_contacts
   where user_id = v.user_id and community_id = v.community_id;
  if pp.rank is null then v_missing := v_missing || 'your rank'; end if;
  if pp.role is null then v_missing := v_missing || 'your role'; end if;
  if coalesce(pc.whatsapp,'') = '' then v_missing := v_missing || 'a WhatsApp number'; end if;
  if array_length(v_missing, 1) > 0 then
    return jsonb_build_object('error','profile', 'missing', v_missing, 'league', v_league);
  end if;

  v_pool := (v_ev.phase = 'registration_open');
  select count(*) into v_played from registrations r join events e on e.id = r.event_id
    where r.user_id = v.user_id and r.community_id = v.community_id and r.status='approved' and e.phase='settled';
  v_strikes := volt_strike_count(v.user_id, v.community_id);   -- rolling 90 days
  v_status := case when v.role in ('host','moderator') then 'approved'
                   when v_played >= 2 and v_strikes = 0 then 'approved' else 'pending' end;

  insert into registrations (event_id, community_id, user_id, status, availability_confirmed, wants_captain, pool_eligible)
  values (v_ev.id, v.community_id, v.user_id, v_status, true, coalesce(p_captain,false), v_pool);

  if v_status = 'pending' then
    insert into notifications (community_id, user_id, event_id, kind, title, body)
    select v.community_id, u.id, v_ev.id, 'new_application', 'New application to review',
           v.display_name || ' applied via Discord.'
      from users u where u.community_id = v.community_id and u.role in ('host','moderator');
  end if;
  return jsonb_build_object('ok', true, 'status', v_status, 'pool', v_pool,
                            'weekend', coalesce(v_ev.weekend_label,'this weekend'));
end $function$
;
