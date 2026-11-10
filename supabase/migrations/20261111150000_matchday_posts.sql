-- Discord match nights: one match-day post, a "player of the night" post, and
-- no automatic pings for group-stage matches.
--
-- volt_pred_due gains:
--   * a `stage` on every row ('group' for a group / league table match,
--     'knockout' for everything after), plus the pick split (votesA/votesB);
--   * mode 'remind' (the hour-before last call, which pings the league role)
--     now skips group-stage matches, so the group stage is never pinged by
--     the timer;
--   * mode 'matchday': scheduled, unplayed matches inside the window that
--     haven't been in a match-day post yet (dayPostedAt);
--   * mode 'potn': scheduled matches that have kicked off and haven't been
--     counted in a player-of-the-night post yet (potnAt), and 'potnall', the
--     same without the kicked-off condition, so the caller can see the whole
--     night.
-- volt_pred_mark accepts the two new stamps.

-- volt_all_matches, with each match tagged with the stage it belongs to.
create or replace function public.volt_all_matches_staged(p_t jsonb)
returns jsonb
language sql
immutable
set search_path to 'public'
as $$
  select case
    when p_t->>'format' = 'group' then
      coalesce((select jsonb_agg(m || '{"stage":"group"}') from jsonb_each(coalesce(p_t->'matches','{}'::jsonb)) g,
                     jsonb_array_elements(g.value) m), '[]'::jsonb)
      || coalesce((select jsonb_agg(m || '{"stage":"knockout"}') from jsonb_array_elements(coalesce(nullif(p_t->'ko','null'::jsonb),'[]'::jsonb)) r,
                     jsonb_array_elements(r) m), '[]'::jsonb)
      || coalesce((select jsonb_agg(m || '{"stage":"knockout"}') from jsonb_array_elements(coalesce(nullif(p_t->'semis','null'::jsonb),'[]'::jsonb)) m), '[]'::jsonb)
      || case when p_t->'final' is not null and p_t->'final' <> 'null'::jsonb
              then jsonb_build_array(p_t->'final' || '{"stage":"knockout"}') else '[]'::jsonb end
    when p_t->>'format' = 'single' then
      coalesce((select jsonb_agg(m || '{"stage":"knockout"}') from jsonb_array_elements(coalesce(p_t->'rounds','[]'::jsonb)) r,
                     jsonb_array_elements(r) m), '[]'::jsonb)
    else
      coalesce((select jsonb_agg(m || '{"stage":"group"}') from jsonb_array_elements(coalesce(p_t->'matches','[]'::jsonb)) m), '[]'::jsonb)
      || case when p_t->'final' is not null and p_t->'final' <> 'null'::jsonb
              then jsonb_build_array(p_t->'final' || '{"stage":"knockout"}') else '[]'::jsonb end
  end;
$$;

create or replace function public.volt_pred_due(p_mins integer default 60, p_mode text default 'remind')
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

create or replace function public.volt_pred_mark(p_event uuid, p_match text, p_field text default 'predictedAt')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_comm uuid; v_key text; v_val text; board jsonb;
begin
  if p_field not in ('predictedAt','remindedAt','dayPostedAt','potnAt') then raise exception 'bad field'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then return jsonb_build_object('ok', false); end if;
  v_key := 'volt-auction-v2::' || p_event::text;
  select val into v_val from community_kv
   where community_id = v_comm and k = v_key and shared and user_id is null for update;
  if v_val is null then return jsonb_build_object('ok', false); end if;
  board := volt_json_set_match(v_val::jsonb, p_match, p_field, to_jsonb(now()));
  perform set_config('volt.skip_bcast', '1', true);
  update community_kv set val = board::text
   where community_id = v_comm and k = v_key and shared and user_id is null;
  perform set_config('volt.skip_bcast', '0', true);
  return jsonb_build_object('ok', true);
end $function$;

revoke execute on function public.volt_pred_mark(uuid, text, text) from public, anon, authenticated;
grant execute on function public.volt_pred_mark(uuid, text, text) to service_role;

-- The 5-minute tick calls the endpoint only when there's something to do.
create or replace function public.volt_run_predictions()
returns bigint
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare v_url text; v_secret text;
begin
  if jsonb_array_length(volt_pred_due(60, 'remind')) = 0
     and jsonb_array_length(volt_pred_due(180, 'autoopen')) = 0
     and jsonb_array_length(volt_pred_due(360, 'matchday')) = 0
     and jsonb_array_length(volt_pred_due(0, 'potn')) = 0 then return null; end if;
  select v into v_url    from volt_config where k = 'notify_url';
  select v into v_secret from volt_config where k = 'notify_secret';
  if v_url is null or v_secret is null then return null; end if;
  return net.http_post(
    url := replace(v_url, '/api/discord-notify', '/api/discord-predictions'),
    headers := jsonb_build_object('Content-Type','application/json','x-volt-secret', v_secret),
    body := '{}'::jsonb);
end $function$;
