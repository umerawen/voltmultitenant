-- ════════════════════════════════════════════════════════════════════
-- Discord bot fixes + support for new commands.
--
-- 1. Which tournament a command means. Every bot function picked "the newest
--    non-settled event", so once a host created next week's tournament while
--    this week's was still running, /roster, /subs, rollcall and prediction
--    votes all looked at the empty new one. volt_dc_event picks by purpose:
--      live   → the furthest-along tournament (matches > draft > reg)
--      signup → the one taking sign-ups (reg open > reg closed > live)
-- 2. Prediction votes find their match on any unfinished tournament's board
--    (match ids are unique), instead of assuming the newest one.
-- 3. Prediction cards open automatically 3 hours before kick-off. Opening was
--    manual only, so a match whose teams were decided late (the final, after
--    the semis) never got a card.
-- 4. volt_dc_board: the tournament + team names, for /standings and /schedule.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.volt_dc_event(p_comm uuid, p_purpose text DEFAULT 'live')
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from events
   where community_id = p_comm and phase <> 'settled'
   order by
     case when p_purpose = 'signup' then
       case phase::text when 'registration_open' then 0 when 'registration_closed' then 1 when 'drafting' then 2 else 3 end
     else
       case phase::text when 'matches_live' then 0 when 'drafting' then 1 when 'registration_closed' then 2 else 3 end
     end,
     starts_on asc nulls last, created_at asc
   limit 1;
$function$
;

-- Tag: the live tournament, else the most recent settled one.
CREATE OR REPLACE FUNCTION public.volt_tournament_tag(p_community uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e record; a date; b date; v_ev uuid;
begin
  v_ev := volt_dc_event(p_community, 'live');
  if v_ev is not null then
    select weekend_label, starts_on, ends_on into e from events where id = v_ev;
  else
    select weekend_label, starts_on, ends_on into e
      from events where community_id = p_community
      order by starts_on desc nulls last limit 1;
  end if;
  if e is null then return null; end if;
  if coalesce(e.weekend_label,'') <> '' then return e.weekend_label; end if;
  a := e.starts_on; b := coalesce(e.ends_on, e.starts_on);
  if a is null then return 'Tournament'; end if;
  if a = b then return to_char(a, 'Mon FMDD');
  elsif date_trunc('month', a) = date_trunc('month', b)
    then return to_char(a, 'Mon FMDD') || '-' || to_char(b, 'FMDD');
  else return to_char(a, 'Mon FMDD') || ' - ' || to_char(b, 'Mon FMDD');
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_discord_status(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev record;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','This server isn''t linked to a VOLT league yet.'); end if;
  select id, weekend_label, phase::text as phase, draft_at into v_ev
    from events where id = volt_dc_event(v_comm, 'signup');
  if v_ev is null then return jsonb_build_object('weekend', null); end if;
  return jsonb_build_object(
    'weekend', coalesce(v_ev.weekend_label, volt_tournament_tag(v_comm), 'This weekend'),
    'phase',   v_ev.phase,
    'draftAt', case when v_ev.draft_at is null then null else extract(epoch from v_ev.draft_at)::bigint end,
    'approved',(select count(*) from registrations where event_id = v_ev.id and status='approved'),
    'pending', (select count(*) from registrations where event_id = v_ev.id and status='pending'));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_confirm(p_guild text DEFAULT NULL::text, p_discord_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_ev record; v_pool boolean;
begin
  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then return jsonb_build_object('error','link'); end if;
  select e.id, coalesce(e.weekend_label,'this weekend') as label, e.draft_at into v_ev
    from events e where e.id = volt_dc_event(v.community_id, 'signup');
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  if not exists (select 1 from registrations where event_id = v_ev.id and user_id = v.user_id) then
    return jsonb_build_object('error','notin'); end if;

  update registrations
     set reconfirmed_at = now(), declined_at = null, availability_confirmed = true
   where event_id = v_ev.id and user_id = v.user_id
   returning coalesce(pool_eligible, true) into v_pool;

  return jsonb_build_object('ok', true, 'weekend', v_ev.label, 'inPool', v_pool,
    'draftAt', case when v_ev.draft_at is null then null
                    else extract(epoch from v_ev.draft_at)::bigint end);
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
    from events where id = volt_dc_event(v.community_id, 'signup')
     and phase in ('registration_open','registration_closed');
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
  v_strikes := volt_strike_count(v.user_id, v.community_id);
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
                            'weekend', coalesce(v_ev.weekend_label, volt_tournament_tag(v.community_id), 'this weekend'));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_withdraw(p_guild text DEFAULT NULL::text, p_discord_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_ev record; v_key text; v_val text; board jsonb;
        pi int; v_stamp bigint; v_name text;
begin
  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then return jsonb_build_object('error','link'); end if;
  select e.id, coalesce(e.weekend_label,'this weekend') as label, e.phase::text as phase, e.draft_at
    into v_ev
    from events e where e.id = volt_dc_event(v.community_id, 'signup');
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  if not exists (select 1 from registrations where event_id = v_ev.id and user_id = v.user_id) then
    return jsonb_build_object('error','notin'); end if;
  if v_ev.phase not in ('registration_open','registration_closed') then
    return jsonb_build_object('error','toolate');
  end if;

  update registrations
     set declined_at = now(), pool_eligible = false,
         reconfirmed_at = null, availability_confirmed = false
   where event_id = v_ev.id and user_id = v.user_id;

  v_key := 'volt-auction-v2::' || v_ev.id::text;
  select val into v_val from community_kv
   where community_id = v.community_id and k = v_key and shared = true and user_id is null
   for update;
  if v_val is not null then
    board := v_val::jsonb;
    select idx - 1 into pi from jsonb_array_elements(board->'players') with ordinality e(pl, idx)
     where pl->>'id' = v.user_id::text limit 1;
    if pi is not null
       and coalesce(board->'players'->pi->>'status','pool') <> 'sold' then
      v_stamp := (extract(epoch from now())*1000)::bigint;
      board := jsonb_set(board, array['players', pi::text, 'poolEligible'], 'false'::jsonb);
      board := jsonb_set(board, '{stamp}', to_jsonb(v_stamp));
      select display_name into v_name from users where id = v.user_id;
      board := jsonb_set(board, '{log}',
        (jsonb_build_array(to_jsonb(coalesce(v_name,'A player') || ' moved to reserves'))
          || coalesce(board->'log','[]'::jsonb)));
      board := volt_trim_board(board);

      perform set_config('volt.skip_bcast', '1', true);
      update community_kv set val = board::text
       where community_id = v.community_id and k = v_key and shared = true and user_id is null;
      perform set_config('volt.skip_bcast', '0', true);

      perform volt_bcast(v.community_id, jsonb_build_object(
        't','reserve', 'event', v_ev.id, 'stamp', v_stamp,
        'playerId', v.user_id::text, 'poolEligible', false));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'weekend', v_ev.label,
    'draftAt', case when v_ev.draft_at is null then null
                    else extract(epoch from v_ev.draft_at)::bigint end);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_roster(p_guild text, p_discord_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_ev uuid; board jsonb; team jsonb; mates jsonb;
begin
  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then return jsonb_build_object('error','link'); end if;
  v_ev := volt_dc_event(v.community_id, 'live');
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  select val::jsonb into board from community_kv
   where community_id = v.community_id and k = 'volt-auction-v2::'||v_ev::text and shared = true and user_id is null;
  if board is null then return jsonb_build_object('error','noboard'); end if;

  select t into team from jsonb_array_elements(board->'teams') t
   where t->>'captainUserId' = v.user_id::text
      or coalesce(t->'roster','[]'::jsonb) ? v.user_id::text
   limit 1;
  if team is null then return jsonb_build_object('error','undrafted'); end if;

  select jsonb_agg(jsonb_build_object('name', p->>'name', 'rank', p->>'rank',
                                      'role', p->>'role', 'captain', false))
    into mates
    from jsonb_array_elements(board->'players') p
   where coalesce(team->'roster','[]'::jsonb) ? (p->>'id');

  return jsonb_build_object('team', team->>'name', 'captain', team->>'captain',
    'budget', team->>'budget', 'mates', coalesce(mates,'[]'::jsonb),
    'youAreCaptain', team->>'captainUserId' = v.user_id::text);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_subs(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev uuid;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  v_ev := volt_dc_event(v_comm, 'live');
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'name', u.display_name, 'rank', coalesce(pp.rank,'—'),
      'discord', pc.discord_user_id))
    from registrations r
    join users u on u.id = r.user_id
    left join player_profiles pp on pp.user_id = u.id and pp.community_id = v_comm
    left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
    where r.event_id = v_ev and r.status = 'approved'
      and coalesce(r.pool_eligible, true) = false
      and r.declined_at is null), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_rollcall(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev uuid;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  v_ev := volt_dc_event(v_comm, 'live');
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  return jsonb_build_object('missing', coalesce((
    select jsonb_agg(jsonb_build_object('name', u.display_name, 'discord', pc.discord_user_id)
                     order by u.display_name)
      from registrations r
      join users u on u.id = r.user_id
      left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
     where r.event_id = v_ev and r.status = 'approved'
       and pc.discord_user_id is null), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_role_members(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev uuid; v_role text;
begin
  select id, discord_role_id into v_comm, v_role
    from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  v_ev := volt_dc_event(v_comm, 'live');
  return jsonb_build_object(
    'roleId', v_role,
    'tag', volt_tournament_tag(v_comm),
    'members', coalesce((
      select jsonb_agg(pc.discord_user_id)
        from registrations r
        join player_contacts pc
          on pc.user_id = r.user_id and pc.community_id = r.community_id
       where r.event_id = v_ev and r.status = 'approved'
         and pc.discord_user_id is not null), '[]'::jsonb),
    'names', coalesce((
      select jsonb_object_agg(pc.discord_user_id, u.display_name)
        from registrations r
        join users u on u.id = r.user_id
        join player_contacts pc
          on pc.user_id = r.user_id and pc.community_id = r.community_id
       where r.event_id = v_ev and r.status = 'approved'
         and pc.discord_user_id is not null), '{}'::jsonb));
end $function$
;

-- Votes find their match on whichever unfinished tournament holds it.
CREATE OR REPLACE FUNCTION public.volt_dc_predict(p_guild text, p_discord_id text, p_match text, p_side text, p_guest_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_comm uuid; v_ev uuid; v_key text; v_val text; board jsonb; m jsonb;
        v_name text; v_voter text; v_votes jsonb; v_a text; v_b text; v_guest boolean := false;
begin
  if p_side not in ('a','b') then return jsonb_build_object('error','badside'); end if;

  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then
    select id into v_comm from communities where discord_guild_id = p_guild;
    if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
    v_guest := true;
    v_voter := 'dc:' || p_discord_id;
    v_name  := coalesce(nullif(trim(p_guest_name), ''), 'Guest');
  else
    v_comm  := v.community_id;
    v_voter := v.user_id::text;
    select display_name into v_name from users where id = v.user_id;
    v_name := coalesce(v_name, 'Player');
  end if;

  -- The board that actually contains this match.
  select e.id into v_ev
    from events e
    join community_kv kv on kv.community_id = e.community_id
     and kv.k = 'volt-auction-v2::' || e.id::text and kv.shared and kv.user_id is null
   where e.community_id = v_comm and e.phase <> 'settled'
     and volt_json_find_match(kv.val::jsonb, p_match) is not null
   limit 1;
  if v_ev is null then return jsonb_build_object('error','nomatch'); end if;

  v_key := 'volt-auction-v2::' || v_ev::text;
  select val into v_val from community_kv
   where community_id = v_comm and k = v_key and shared and user_id is null for update;
  board := v_val::jsonb;

  m := volt_json_find_match(board, p_match);
  if m is null then return jsonb_build_object('error','nomatch'); end if;
  if coalesce((m->>'done')::boolean,false) then return jsonb_build_object('error','done'); end if;
  if m->>'scheduledAt' is not null
     and (m->>'scheduledAt')::timestamptz <= now() then
    return jsonb_build_object('error','started');
  end if;

  v_votes := coalesce(m->'votes', '{}'::jsonb);
  v_votes := jsonb_set(v_votes, array[v_voter],
    jsonb_build_object('side', p_side, 'name', v_name, 'guest', v_guest));

  board := volt_json_set_match(board, p_match, 'votes', v_votes);
  perform set_config('volt.skip_bcast', '1', true);
  update community_kv set val = board::text
   where community_id = v_comm and k = v_key and shared and user_id is null;
  perform set_config('volt.skip_bcast', '0', true);

  select x->>'name' into v_a from jsonb_array_elements(board->'teams') x where x->>'id' = m->>'teamA';
  select x->>'name' into v_b from jsonb_array_elements(board->'teams') x where x->>'id' = m->>'teamB';
  perform volt_bcast(v_comm, jsonb_build_object('t','vote','event',v_ev));

  return jsonb_build_object('ok', true, 'guest', v_guest,
    'picked', case when p_side = 'a' then v_a else v_b end,
    'other',  case when p_side = 'a' then v_b else v_a end);
end $function$
;

-- 'autoopen' mode: cards not yet posted whose kick-off is within p_mins.
CREATE OR REPLACE FUNCTION public.volt_pred_due(p_mins integer DEFAULT 60, p_mode text DEFAULT 'remind'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; out jsonb := '[]'::jsonb; board jsonb; t jsonb; m jsonb; names jsonb;
        want boolean;
begin
  for r in
    select e.id as event_id, e.community_id, c.discord_guild_id, kv.val
      from events e
      join communities c on c.id = e.community_id
      join community_kv kv on kv.community_id = e.community_id
       and kv.k = 'volt-auction-v2::' || e.id::text and kv.shared and kv.user_id is null
     where e.phase in ('drafting','matches_live')
       and c.discord_guild_id is not null
  loop
    board := r.val::jsonb;
    t := board->'tournament';
    if t is null or t = 'null'::jsonb then continue; end if;

    select coalesce(jsonb_object_agg(x->>'id', jsonb_build_object('name', x->>'name')), '{}'::jsonb)
      into names from jsonb_array_elements(board->'teams') x;

    for m in select * from jsonb_array_elements(volt_all_matches(t)) loop
      if m->>'scheduledAt' is null then continue; end if;
      if coalesce((m->>'done')::boolean, false) then continue; end if;
      if names->>(m->>'teamA') is null or names->>(m->>'teamB') is null then continue; end if;
      if (m->>'scheduledAt')::timestamptz <= now() then continue; end if;

      if p_mode = 'open' then
        want := m->>'predictedAt' is null;
      elsif p_mode = 'autoopen' then
        want := m->>'predictedAt' is null
            and (m->>'scheduledAt')::timestamptz <= now() + make_interval(mins => p_mins);
      else
        want := m->>'predictedAt' is not null
            and m->>'remindedAt' is null
            and (m->>'scheduledAt')::timestamptz <= now() + make_interval(mins => p_mins);
      end if;
      if not want then continue; end if;

      out := out || jsonb_build_array(jsonb_build_object(
        'eventId', r.event_id, 'communityId', r.community_id, 'guild', r.discord_guild_id,
        'matchId', m->>'id',
        'a', names->(m->>'teamA')->>'name', 'b', names->(m->>'teamB')->>'name',
        'at', extract(epoch from (m->>'scheduledAt')::timestamptz)::bigint,
        'bo', m->>'bo', 'tag', volt_tournament_tag(r.community_id)));
    end loop;
  end loop;
  return out;
end $function$
;

-- The DB tick calls the endpoint when a card is due to auto-open or remind.
CREATE OR REPLACE FUNCTION public.volt_run_predictions()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_url text; v_secret text;
begin
  if jsonb_array_length(volt_pred_due(60, 'remind')) = 0
     and jsonb_array_length(volt_pred_due(180, 'autoopen')) = 0 then return null; end if;
  select v into v_url    from volt_config where k = 'notify_url';
  select v into v_secret from volt_config where k = 'notify_secret';
  if v_url is null or v_secret is null then return null; end if;
  return net.http_post(
    url := replace(v_url, '/api/discord-notify', '/api/discord-predictions'),
    headers := jsonb_build_object('Content-Type','application/json','x-volt-secret', v_secret),
    body := '{}'::jsonb);
end $function$
;

-- Tournament + team names for /standings and /schedule. Small on purpose: the
-- full board carries every player and is far too big to ship per command.
CREATE OR REPLACE FUNCTION public.volt_dc_board(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev uuid; board jsonb;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  v_ev := volt_dc_event(v_comm, 'live');
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  select val::jsonb into board from community_kv
   where community_id = v_comm and k = 'volt-auction-v2::' || v_ev::text and shared and user_id is null;
  if board is null or board->'tournament' is null or board->'tournament' = 'null'::jsonb then
    return jsonb_build_object('error','nofixtures', 'tag', volt_tournament_tag(v_comm)); end if;
  return jsonb_build_object(
    'tag', volt_tournament_tag(v_comm),
    'tournament', board->'tournament',
    'teams', coalesce((select jsonb_agg(jsonb_build_object(
               'id', t->>'id', 'name', t->>'name', 'captainUserId', t->>'captainUserId',
               'roster', coalesce(t->'roster','[]'::jsonb)))
             from jsonb_array_elements(board->'teams') t), '[]'::jsonb));
end $function$
;

do $$
declare f text;
begin
  foreach f in array array['public.volt_dc_event(uuid,text)', 'public.volt_dc_board(text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
