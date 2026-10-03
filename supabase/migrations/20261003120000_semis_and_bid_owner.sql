-- ════════════════════════════════════════════════════════════════════
-- 1. Group-stage semifinals were invisible to every prediction function.
--    Two groups default to semis, but volt_json_find_match/_set_match,
--    volt_pred_due and volt_pred_standings only looked at group matches and
--    the final. So Discord votes on a semi failed ("nomatch"), no prediction
--    card or reminder was ever posted for one, and semi votes never scored.
-- 2. volt_place_bid accepted any team id from any league member, so a
--    player could bid on a rival captain's behalf. A team tied to a captain
--    now only takes bids from that captain or league staff.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.volt_json_find_match(p_board jsonb, p_match text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare t jsonb; grp text; m jsonb;
begin
  t := p_board->'tournament';
  if t is null then return null; end if;
  if t->>'format' = 'group' then
    for grp in select jsonb_object_keys(t->'matches') loop
      for m in select * from jsonb_array_elements(t->'matches'->grp) loop
        if m->>'id' = p_match then return m; end if;
      end loop;
    end loop;
    for m in select * from jsonb_array_elements(coalesce(nullif(t->'semis','null'::jsonb),'[]'::jsonb)) loop
      if m->>'id' = p_match then return m; end if;
    end loop;
    if t->'final'->>'id' = p_match then return t->'final'; end if;
  elsif t->>'format' = 'single' then
    for m in select jsonb_array_elements(value) from jsonb_array_elements(t->'rounds') loop
      if m->>'id' = p_match then return m; end if;
    end loop;
  else
    for m in select * from jsonb_array_elements(coalesce(t->'matches','[]'::jsonb)) loop
      if m->>'id' = p_match then return m; end if;
    end loop;
    if t->'final'->>'id' = p_match then return t->'final'; end if;
  end if;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_json_set_match(p_board jsonb, p_match text, p_key text, p_val jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare t jsonb; grp text; i int; arr jsonb;
begin
  t := p_board->'tournament';
  if t is null then return p_board; end if;

  if t->>'format' = 'group' then
    for grp in select jsonb_object_keys(t->'matches') loop
      arr := t->'matches'->grp;
      for i in 0 .. coalesce(jsonb_array_length(arr),1) - 1 loop
        if arr->i->>'id' = p_match then
          return jsonb_set(p_board, array['tournament','matches',grp,i::text,p_key], p_val);
        end if;
      end loop;
    end loop;
    arr := coalesce(nullif(t->'semis','null'::jsonb),'[]'::jsonb);
    for i in 0 .. jsonb_array_length(arr) - 1 loop
      if arr->i->>'id' = p_match then
        return jsonb_set(p_board, array['tournament','semis',i::text,p_key], p_val);
      end if;
    end loop;
    if t->'final'->>'id' = p_match then
      return jsonb_set(p_board, array['tournament','final',p_key], p_val);
    end if;
  elsif t->>'format' = 'single' then
    for i in 0 .. coalesce(jsonb_array_length(t->'rounds'),1) - 1 loop
      arr := t->'rounds'->i;
      for grp in select generate_series(0, coalesce(jsonb_array_length(arr),1) - 1)::text loop
        if arr->(grp::int)->>'id' = p_match then
          return jsonb_set(p_board, array['tournament','rounds',i::text,grp,p_key], p_val);
        end if;
      end loop;
    end loop;
  else
    arr := t->'matches';
    for i in 0 .. coalesce(jsonb_array_length(arr),1) - 1 loop
      if arr->i->>'id' = p_match then
        return jsonb_set(p_board, array['tournament','matches',i::text,p_key], p_val);
      end if;
    end loop;
    if t->'final'->>'id' = p_match then
      return jsonb_set(p_board, array['tournament','final',p_key], p_val);
    end if;
  end if;
  return p_board;
end $function$
;

-- Every match of a tournament, flattened (group matches, semis, final; bracket
-- rounds; league matches + final). One definition instead of three copies.
CREATE OR REPLACE FUNCTION public.volt_all_matches(p_t jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_t->>'format' = 'group' then
      coalesce((select jsonb_agg(m) from jsonb_each(coalesce(p_t->'matches','{}'::jsonb)) g,
                     jsonb_array_elements(g.value) m), '[]'::jsonb)
      || coalesce(nullif(p_t->'semis','null'::jsonb), '[]'::jsonb)
      || case when p_t->'final' is not null and p_t->'final' <> 'null'::jsonb
              then jsonb_build_array(p_t->'final') else '[]'::jsonb end
    when p_t->>'format' = 'single' then
      coalesce((select jsonb_agg(m) from jsonb_array_elements(coalesce(p_t->'rounds','[]'::jsonb)) r,
                     jsonb_array_elements(r) m), '[]'::jsonb)
    else
      coalesce(p_t->'matches','[]'::jsonb)
      || case when p_t->'final' is not null and p_t->'final' <> 'null'::jsonb
              then jsonb_build_array(p_t->'final') else '[]'::jsonb end
  end;
$function$
;

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
      -- Never for a match already under way; voting is closed by then.
      if (m->>'scheduledAt')::timestamptz <= now() then continue; end if;

      if p_mode = 'open' then
        want := m->>'predictedAt' is null;
      else
        want := m->>'predictedAt' is not null           -- card is up
            and m->>'remindedAt' is null                -- not nudged yet
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

CREATE OR REPLACE FUNCTION public.volt_pred_standings(p_community uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      if m->'votes' is null then continue; end if;
      v_win := case when m->>'winner' = m->>'teamA' then 'a'
                    when m->>'winner' = m->>'teamB' then 'b' else null end;
      if v_win is null then continue; end if;

      for uid, vote in select key, value from jsonb_each(m->'votes') loop
        cur := coalesce(tally->uid, jsonb_build_object('hit',0,'total',0,'name',null,'guest',false));
        tally := jsonb_set(tally, array[uid], jsonb_build_object(
          'hit',   (cur->>'hit')::int + (case when vote->>'side' = v_win then 1 else 0 end),
          'total', (cur->>'total')::int + 1,
          -- Newest name wins: people rename, and the latest vote is the freshest.
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
                 -- Real accounts prefer the live display name; guests only ever
                 -- have the one stored on the vote.
                 'name', coalesce(u.display_name, v->>'name', 'Player'),
                 'guest', coalesce((v->>'guest')::boolean, false),
                 'hit', (v->>'hit')::int,
                 'total', (v->>'total')::int,
                 'pct', round(((v->>'hit')::numeric / nullif((v->>'total')::numeric,0)) * 100)) x
          from jsonb_each(tally) e(k, v)
          left join users u on k ~ '^[0-9a-f-]{36}$' and u.id::text = k
         where (v->>'total')::int > 0) q), '[]'::jsonb);
end $function$
;

-- Bid ownership.
CREATE OR REPLACE FUNCTION public.volt_place_bid(p_event uuid, p_team text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid(); v_comm uuid; v_key text; v_val text;
  b jsonb; board jsonb; team jsonb; ti int;
  v_req int; v_slots int; v_reserve int; v_max int;
  v_pname text; v_tname text; v_ts timestamptz; v_stamp bigint; v_staff boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such weekend'; end if;
  select role::text in ('host','moderator') into v_staff
    from users where id = v_uid and community_id = v_comm;
  if v_staff is null then raise exception 'not a member of this league'; end if;
  v_key := 'volt-auction-v2::' || p_event::text;

  select val into v_val from community_kv
   where community_id = v_comm and k = v_key and shared = true and user_id is null for update;
  if v_val is null then raise exception 'no auction board yet'; end if;
  board := v_val::jsonb;

  b := board->'block';
  if b is null or b = 'null'::jsonb then raise exception 'Nobody is on the block right now.'; end if;
  if b->>'leaderId' = p_team then raise exception 'You are already the leading bid.'; end if;

  select idx - 1, t into ti, team from jsonb_array_elements(board->'teams') with ordinality e(t, idx)
   where t->>'id' = p_team limit 1;
  if team is null then raise exception 'That team is not in this auction.'; end if;
  -- A team that belongs to a captain only bids through that captain (or staff
  -- covering for them). Hand-made teams with no linked captain stay open.
  if coalesce(team->>'captainUserId','') <> '' and team->>'captainUserId' <> v_uid::text and not v_staff then
    raise exception 'You can only bid for your own team.';
  end if;
  if jsonb_array_length(coalesce(team->'roster','[]'::jsonb)) >= 4 then
    raise exception 'Your roster is already full.'; end if;

  v_req := case when coalesce(b->>'leaderId','') <> ''
                then (b->>'currentBid')::int + 100 else (b->>'startingBid')::int end;
  v_slots := greatest(4 - jsonb_array_length(coalesce(team->'roster','[]'::jsonb)) - 1, 0);
  if v_slots = 0 then v_reserve := 0;
  else
    select coalesce(sum(v),0) into v_reserve from (
      select volt_rank_bid(p->>'rank') as v from jsonb_array_elements(board->'players') p
       where p->>'status' = 'pool'
         and coalesce((p->>'isCaptain')::boolean,false) = false
         and coalesce((p->>'poolEligible')::boolean,true) = true
       order by 1 limit v_slots) q;
  end if;
  v_max := (team->>'budget')::int - v_reserve;
  if v_max < v_req then
    raise exception 'That bid would leave you unable to fill your roster (your limit is %).', v_max; end if;

  select p->>'name' into v_pname from jsonb_array_elements(board->'players') p
   where p->>'id' = b->>'playerId' limit 1;
  v_tname := team->>'name';
  v_stamp := (extract(epoch from now())*1000)::bigint;

  board := jsonb_set(board, '{block,currentBid}', to_jsonb(v_req));
  board := jsonb_set(board, '{block,leaderId}', to_jsonb(p_team));
  board := jsonb_set(board, '{block,ts}', to_jsonb(v_stamp));
  board := jsonb_set(board, '{bidHistory}',
    (jsonb_build_array(jsonb_build_object('teamId',p_team,'amount',v_req,'ts',v_stamp))
      || coalesce(board->'bidHistory','[]'::jsonb)));
  board := jsonb_set(board, '{log}',
    (jsonb_build_array(to_jsonb(v_tname||' bids $'||v_req::text||' on '||coalesce(v_pname,'the player')))
      || coalesce(board->'log','[]'::jsonb)));
  board := jsonb_set(board, '{stamp}', to_jsonb(v_stamp));
  board := volt_trim_board(board);

  perform set_config('volt.skip_bcast', '1', true);   -- the delta below replaces the generic signal
  update community_kv set val = board::text
   where community_id = v_comm and k = v_key and shared = true and user_id is null
   returning updated_at into v_ts;
  perform set_config('volt.skip_bcast', '0', true);

  perform volt_bcast(v_comm, jsonb_build_object(
    't','bid', 'event', p_event, 'stamp', v_stamp,
    'currentBid', v_req, 'leaderId', p_team, 'teamName', v_tname,
    'playerName', coalesce(v_pname,'the player'), 'updatedAt', v_ts));

  return jsonb_build_object('board', board, 'updatedAt', v_ts);
end $function$
;
