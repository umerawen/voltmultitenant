-- Forfeits, captain sub requests, and a server clock for the prediction lock.

-- ── Server clock ─────────────────────────────────────────────────────────
-- The app measures how far the device clock is off and corrects for it, so a
-- phone with the wrong time can't keep predictions open past kick-off.
create or replace function public.volt_now()
 returns double precision
 language sql
 stable
as $$ select extract(epoch from clock_timestamp()) * 1000 $$;
grant execute on function public.volt_now() to anon, authenticated, service_role;

-- ── Forfeits ─────────────────────────────────────────────────────────────
-- A forfeited match carries `forfeit: 'a' | 'b'` (the side that gave it up) and
-- a 13–0 map score, so tables and result lines need no special case. Nobody
-- predicted a walkover, so those picks don't count.
create or replace function public.volt_pred_standings(p_community uuid default null::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_comm uuid; r record; board jsonb; t jsonb; m jsonb;
        v_win text; uid text; vote jsonb; tally jsonb := '{}'::jsonb; cur jsonb;
begin
  v_comm := coalesce(p_community, auth_community_id());
  if v_comm is null then return '[]'::jsonb; end if;

  for r in
    select kv.val
      from events e
      join community_kv kv on kv.community_id = e.community_id
       and kv.k = 'volt-auction-v2::' || e.id::text and kv.shared and kv.user_id is null
     where e.community_id = v_comm
  loop
    board := r.val::jsonb;
    t := board->'tournament';
    if t is null or t = 'null'::jsonb then continue; end if;

    for m in select * from jsonb_array_elements(volt_all_matches(t)) loop
      if not coalesce((m->>'done')::boolean, false) then continue; end if;
      if m->>'forfeit' is not null then continue; end if;
      if m->'votes' is null then continue; end if;
      v_win := case when m->>'winner' = m->>'teamA' then 'a'
                    when m->>'winner' = m->>'teamB' then 'b' else null end;
      if v_win is null then continue; end if;

      for uid, vote in select key, value from jsonb_each(m->'votes') loop
        cur := coalesce(tally->uid, jsonb_build_object('hit',0,'total',0,'name',null,'guest',false));
        tally := jsonb_set(tally, array[uid], jsonb_build_object(
          'hit',   (cur->>'hit')::int + (case when vote->>'side' = v_win then 1 else 0 end),
          'total', (cur->>'total')::int + 1,
          'name',  coalesce(vote->>'name', cur->>'name'),
          'guest', coalesce((vote->>'guest')::boolean, cur->>'guest' = 'true')));
      end loop;
    end loop;
  end loop;

  return coalesce((
    select jsonb_agg(x order by (x->>'hit')::int desc, (x->>'pct')::numeric desc, x->>'name')
      from (
        select jsonb_build_object(
                 'userId', k,
                 'name', coalesce(u.display_name, v->>'name', 'Player'),
                 'guest', coalesce((v->>'guest')::boolean, false),
                 'hit', (v->>'hit')::int,
                 'total', (v->>'total')::int,
                 'pct', round(((v->>'hit')::numeric / nullif((v->>'total')::numeric,0)) * 100)) x
          from jsonb_each(tally) e(k, v)
          left join users u on k ~ '^[0-9a-f-]{36}$' and u.id::text = k and u.community_id = v_comm
         where (v->>'total')::int > 0) q), '[]'::jsonb);
end $function$;

-- Each row now says whether the match was forfeited, so the player-of-the-night
-- post doesn't wait on stats that will never be reported.
create or replace function public.volt_pred_due(p_mins integer default 60, p_mode text default 'remind'::text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare r record; out jsonb := '[]'::jsonb; board jsonb; t jsonb; m jsonb; names jsonb;
        want boolean; at timestamptz; done boolean;
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
    for m in select * from jsonb_array_elements(volt_all_matches_staged(t)) loop
      if m->>'scheduledAt' is null then continue; end if;
      if names->>(m->>'teamA') is null or names->>(m->>'teamB') is null then continue; end if;
      at := (m->>'scheduledAt')::timestamptz;
      done := coalesce((m->>'done')::boolean, false);
      if p_mode in ('potn', 'potnall') then
        want := m->>'potnAt' is null and (p_mode = 'potnall' or at <= now());
      else
        -- Every other mode is about a match still to be played.
        if done or at <= now() then continue; end if;
        if p_mode = 'open' then
          want := m->>'predictedAt' is null;
        elsif p_mode = 'autoopen' then
          want := m->>'predictedAt' is null and at <= now() + make_interval(mins => p_mins);
        elsif p_mode = 'matchday' then
          want := m->>'dayPostedAt' is null and at <= now() + make_interval(mins => p_mins);
        else
          -- The last call pings the league role: never for the group stage.
          want := m->>'predictedAt' is not null
              and m->>'remindedAt' is null
              and m->>'stage' <> 'group'
              and at <= now() + make_interval(mins => p_mins);
        end if;
      end if;
      if not want then continue; end if;
      out := out || jsonb_build_array(jsonb_build_object(
        'eventId', r.event_id, 'communityId', r.community_id, 'guild', r.discord_guild_id,
        'matchId', m->>'id', 'stage', m->>'stage', 'done', done,
        'forfeit', m->>'forfeit' is not null,
        'a', names->(m->>'teamA')->>'name', 'b', names->(m->>'teamB')->>'name',
        'at', extract(epoch from at)::bigint,
        'votesA', (select count(*) from jsonb_each(coalesce(nullif(m->'votes','null'::jsonb),'{}'::jsonb)) v where v.value->>'side' = 'a'),
        'votesB', (select count(*) from jsonb_each(coalesce(nullif(m->'votes','null'::jsonb),'{}'::jsonb)) v where v.value->>'side' = 'b'),
        'bo', m->>'bo', 'tag', volt_tournament_tag(r.community_id)));
    end loop;
  end loop;
  return out;
end $function$;
revoke execute on function public.volt_pred_due(integer, text) from public, anon, authenticated;
grant execute on function public.volt_pred_due(integer, text) to service_role;

-- ── Sub requests ─────────────────────────────────────────────────────────
alter table public.sub_requests add column if not exists notified_at timestamptz;

-- Who can cover: approved, a lower rank than the player going out, and not
-- already playing — so not on a roster, not a captain, not already subbing in.
-- Before this it listed every lower-ranked registrant, drafted players included.
create or replace function public.volt_sub_eligible(p_event uuid, p_out uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_comm uuid; v_rank text; v_idx int; v_val text; v_players jsonb;
begin
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such tournament'; end if;
  if auth.uid() is not null and v_comm is distinct from auth_community_id() then
    raise exception 'no such tournament';
  end if;
  select rank into v_rank from player_profiles where user_id = p_out and community_id = v_comm;
  v_idx := volt_rank_index(v_rank);
  select val into v_val from community_kv
   where community_id = v_comm and k = 'volt-auction-v2::' || p_event::text
     and shared = true and user_id is null;
  v_players := case when v_val is null then '[]'::jsonb
                    else coalesce(nullif(v_val::jsonb->'players', 'null'::jsonb), '[]'::jsonb) end;

  return jsonb_build_object(
    'outRank', v_rank,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'userId', u.id, 'name', u.display_name,
               'rank', pp.rank, 'rankDiv', pp.rank_div, 'role', pp.role,
               'linked', pc.discord_user_id is not null)
             order by volt_rank_index(pp.rank) desc, u.display_name)
        from registrations r
        join users u on u.id = r.user_id and u.community_id = r.community_id
        left join player_profiles pp on pp.user_id = u.id and pp.community_id = v_comm
        left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
       where r.event_id = p_event
         and r.status = 'approved'
         and r.user_id <> p_out
         and not coalesce(r.is_captain, false)
         and coalesce(r.declined_at::text,'') = ''
         and volt_rank_index(pp.rank) < v_idx
         and coalesce((select suspension_remaining from users where id = u.id and community_id = v_comm), 0) = 0
         and not exists (select 1 from jsonb_array_elements(v_players) bp
                          where bp->>'id' = u.id::text
                            and (bp->>'status' = 'sold' or bp->>'isCaptain' = 'true'))
         and not exists (select 1 from sub_requests sr
                          where sr.event_id = p_event and sr.filled_user_id = u.id and sr.status = 'filled')
    ), '[]'::jsonb));
end $function$;

-- A reserve offering from inside the app (the Discord button goes through
-- volt_sub_offer with the service key).
create or replace function public.volt_sub_offer_me(p_request uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from sub_requests where id = p_request;
  if v_comm is null or v_comm is distinct from auth_community_id() then
    return jsonb_build_object('error','gone');
  end if;
  return volt_sub_offer(p_request, v_uid);
end $function$;
revoke execute on function public.volt_sub_offer_me(uuid) from public, anon;
grant execute on function public.volt_sub_offer_me(uuid) to authenticated, service_role;

-- Called by api/discord-notify once it has checked the caller: tells everyone
-- eligible in the app, tells staff a captain asked, and hands back who to DM.
-- Sends once per request.
create or replace function public.volt_sub_notify(p_request uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r record; el jsonb; n int;
begin
  select * into r from sub_requests where id = p_request for update;
  if not found or r.status <> 'open' then return jsonb_build_object('error','closed'); end if;
  if r.notified_at is not null then return jsonb_build_object('error','already_sent'); end if;
  el := volt_sub_eligible(r.event_id, r.out_user_id)->'players';
  n := jsonb_array_length(el);
  -- Nobody to ask: say so and send nothing. The app cancels the request.
  if n = 0 then
    return jsonb_build_object('ok', true, 'eligible', 0, 'targets', '[]'::jsonb,
      'team', r.team_name, 'outName', r.out_name, 'outRank', r.out_rank);
  end if;
  update sub_requests set notified_at = now() where id = p_request;

  insert into notifications (community_id, user_id, event_id, kind, title, body)
  select r.community_id, (e->>'userId')::uuid, r.event_id, 'sub_request',
         r.team_name || ' needs a sub',
         coalesce(r.out_name, 'A player') || ' can''t make it and you''re eligible to cover. Offer from the Reserve Hub.'
    from jsonb_array_elements(el) e;

  insert into notifications (community_id, user_id, event_id, kind, title, body)
  select r.community_id, u.id, r.event_id, 'sub_request',
         r.team_name || ' asked for a sub',
         'Covering for ' || coalesce(r.out_name, 'a player') || '. '
           || n || ' eligible reserve' || case when n = 1 then ' was' else 's were' end || ' asked.'
    from users u
   where u.community_id = r.community_id and u.role in ('host','moderator') and u.id <> r.captain_id;

  return jsonb_build_object('ok', true, 'team', r.team_name, 'outName', r.out_name, 'outRank', r.out_rank,
    'eligible', n,
    'targets', coalesce((
      select jsonb_agg(pc.discord_user_id)
        from jsonb_array_elements(el) e
        join player_contacts pc on pc.user_id = (e->>'userId')::uuid and pc.community_id = r.community_id
       where pc.discord_user_id is not null), '[]'::jsonb));
end $function$;
revoke execute on function public.volt_sub_notify(uuid) from public, anon, authenticated;
grant execute on function public.volt_sub_notify(uuid) to service_role;

-- Filling a request now tells the player who was picked, and the others who
-- offered that the spot has gone.
create or replace function public.volt_sub_fill(p_request uuid, p_user uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); r record; v_ok boolean; v_name text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into r from sub_requests where id = p_request for update;
  if r is null then raise exception 'no such request'; end if;
  if r.status <> 'open' then return jsonb_build_object('error','closed'); end if;

  select (r.captain_id = v_uid
       or exists (select 1 from users where id = v_uid and community_id = r.community_id
                    and role::text in ('host','moderator'))) into v_ok;
  if not v_ok then raise exception 'only the captain who asked, or staff, can fill this'; end if;

  if not exists (select 1 from sub_offers where request_id = p_request and user_id = p_user) then
    return jsonb_build_object('error','not_offered');
  end if;

  update sub_requests set status = 'filled', filled_user_id = p_user where id = p_request;
  select display_name into v_name from users where id = p_user and community_id = r.community_id;

  insert into league_events (community_id, event_id, kind, subject_user_id, subject_name,
                             team_name, detail)
  values (r.community_id, r.event_id, 'SUB_IN', p_user, v_name, r.team_name,
          'covering for ' || coalesce(r.out_name,'a player'));

  insert into notifications (community_id, user_id, event_id, kind, title, body)
  values (r.community_id, p_user, r.event_id, 'sub_in',
          'You''re subbing in for ' || r.team_name,
          'You''re covering for ' || coalesce(r.out_name, 'a player') || '. The captain will be in touch.');
  insert into notifications (community_id, user_id, event_id, kind, title, body)
  select r.community_id, o.user_id, r.event_id, 'sub_filled',
         r.team_name || ' found their sub',
         'Thanks for offering. The captain went with someone else this time.'
    from sub_offers o
   where o.request_id = p_request and o.user_id <> p_user;

  return jsonb_build_object('ok', true, 'name', v_name, 'team', r.team_name);
end $function$;
