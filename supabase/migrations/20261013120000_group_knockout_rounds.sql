-- ════════════════════════════════════════════════════════════════════
-- Big leagues: the group stage now allows up to eight groups and can send the
-- top one or two from each into a knockout. More than four qualifiers adds
-- rounds ahead of the semis, stored on the board as tournament.ko — an array
-- of rounds (round of 16, quarterfinals), each an array of matches with the
-- same shape as every other match.
--
-- Teach the four functions that walk a tournament about tournament.ko, so
-- Discord votes, prediction cards/reminders/scoring and /fixtures cover the
-- new rounds. Byes (one team) are in the lists like single-elim byes are;
-- everything downstream already skips matches without two teams.
-- Grants are unchanged (CREATE OR REPLACE keeps them).
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
    for m in select jsonb_array_elements(value) from jsonb_array_elements(coalesce(nullif(t->'ko','null'::jsonb),'[]'::jsonb)) loop
      if m->>'id' = p_match then return m; end if;
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
declare t jsonb; grp text; i int; j int; arr jsonb;
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
    arr := coalesce(nullif(t->'ko','null'::jsonb),'[]'::jsonb);
    for i in 0 .. jsonb_array_length(arr) - 1 loop
      for j in 0 .. coalesce(jsonb_array_length(arr->i),0) - 1 loop
        if arr->i->j->>'id' = p_match then
          return jsonb_set(p_board, array['tournament','ko',i::text,j::text,p_key], p_val);
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
      || coalesce((select jsonb_agg(m) from jsonb_array_elements(coalesce(nullif(p_t->'ko','null'::jsonb),'[]'::jsonb)) r,
                     jsonb_array_elements(r) m), '[]'::jsonb)
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

CREATE OR REPLACE FUNCTION public.volt_dc_fixtures(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_val text; board jsonb; t jsonb; ms jsonb := '[]'::jsonb; names jsonb;
begin
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then return jsonb_build_object('error','noevent'); end if;
  select val into v_val from community_kv
   where community_id = v_comm and k = 'volt-auction-v2::' || p_event::text
     and shared = true and user_id is null;
  if v_val is null then return jsonb_build_object('error','noboard'); end if;
  board := v_val::jsonb;
  t := board->'tournament';
  if t is null or t = 'null'::jsonb then return jsonb_build_object('error','nofixtures'); end if;

  select coalesce(jsonb_object_agg(x->>'id', x->>'name'), '{}'::jsonb) into names
    from jsonb_array_elements(board->'teams') x;

  if t->>'format' = 'group' then
    select coalesce(jsonb_agg(m), '[]'::jsonb) into ms
      from (select jsonb_array_elements(value) m from jsonb_each(t->'matches')) q;
    -- Knockout rounds, semis and the final sit after the groups. Rounds 80+,
    -- 90 and 99 are sort keys only — they place the knockouts after every
    -- matchday without colliding with a real group round number.
    if t->'ko' is not null and t->'ko' <> 'null'::jsonb then
      ms := ms || (select coalesce(jsonb_agg(jsonb_set(m, '{round}', to_jsonb(80 + (r.ord - 1)::int))), '[]'::jsonb)
                     from jsonb_array_elements(t->'ko') with ordinality r(val, ord),
                          jsonb_array_elements(r.val) m);
    end if;
    if t->'semis' is not null and t->'semis' <> 'null'::jsonb then
      ms := ms || (select coalesce(jsonb_agg(jsonb_set(m, '{round}', to_jsonb(90))), '[]'::jsonb)
                     from jsonb_array_elements(t->'semis') m);
    end if;
    if t->'final' is not null and t->'final' <> 'null'::jsonb then
      ms := ms || jsonb_build_array(jsonb_set(t->'final', '{round}', to_jsonb(99)));
    end if;
  elsif t->>'format' = 'single' then
    select coalesce(jsonb_agg(m), '[]'::jsonb) into ms
      from (select jsonb_array_elements(value) m from jsonb_array_elements(t->'rounds')) q;
  else
    ms := coalesce(t->'matches', '[]'::jsonb);
    if t->'final' is not null and t->'final' <> 'null'::jsonb then
      ms := ms || jsonb_build_array(jsonb_set(t->'final', '{round}', to_jsonb(99)));
    end if;
  end if;

  return jsonb_build_object(
    'format', t->>'format',
    'tag', volt_tournament_tag(v_comm),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'round', (m->>'round')::int,
               'a', coalesce(names->>(m->>'teamA'), 'TBD'),
               'b', coalesce(names->>(m->>'teamB'), 'TBD'),
               'at', m->>'scheduledAt',
               'done', coalesce((m->>'done')::boolean, false),
               'winner', case when m->>'winner' is null then null
                              else coalesce(names->>(m->>'winner'), null) end,
               'bo', (m->>'bo')::int)
             order by (m->>'scheduledAt') is null, m->>'scheduledAt', (m->>'round')::int)
      from jsonb_array_elements(ms) m
     where m->>'teamA' is not null and m->>'teamB' is not null), '[]'::jsonb));
end $function$
;
