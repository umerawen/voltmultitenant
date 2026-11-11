-- Prediction points: a correct pick is worth 1, or 2 when it was an upset, and
-- each row carries the player's current run of correct picks.
--
-- An upset is a winner that fewer than 25% of the picks were on, counted when
-- the match is scored, with at least 5 picks on the match (so one lone vote
-- can't make everything an upset). Forfeits still don't count.
--
-- The board now ranks on points, then correct picks, then accuracy. Matches are
-- walked in kick-off order so the streak means "their last N picks in a row".
-- A match someone didn't pick doesn't break their streak; a wrong pick does.
create or replace function public.volt_pred_standings(p_community uuid default null::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_comm uuid; m jsonb; v_win text; uid text; vote jsonb;
        tally jsonb := '{}'::jsonb; cur jsonb;
        v_n int; v_w int; v_upset boolean; v_hit boolean;
begin
  v_comm := coalesce(p_community, auth_community_id());
  if v_comm is null then return '[]'::jsonb; end if;

  for m in
    select x.m
      from events e
      join community_kv kv on kv.community_id = e.community_id
       and kv.k = 'volt-auction-v2::' || e.id::text and kv.shared and kv.user_id is null
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(kv.val::jsonb->'tournament') = 'object'
             then volt_all_matches(kv.val::jsonb->'tournament') else '[]'::jsonb end) x(m)
     where e.community_id = v_comm
     order by nullif(x.m->>'scheduledAt', '')::timestamptz nulls last, e.created_at
  loop
    if not coalesce((m->>'done')::boolean, false) then continue; end if;
    if m->>'forfeit' is not null then continue; end if;
    if jsonb_typeof(m->'votes') is distinct from 'object' then continue; end if;
    v_win := case when m->>'winner' = m->>'teamA' then 'a'
                  when m->>'winner' = m->>'teamB' then 'b' else null end;
    if v_win is null then continue; end if;

    select count(*), count(*) filter (where v.value->>'side' = v_win)
      into v_n, v_w from jsonb_each(m->'votes') v;
    v_upset := v_n >= 5 and v_w::numeric / v_n < 0.25;

    for uid, vote in select key, value from jsonb_each(m->'votes') loop
      cur := coalesce(tally->uid, jsonb_build_object(
        'hit',0,'total',0,'pts',0,'upsets',0,'streak',0,'name',null,'guest',false));
      v_hit := vote->>'side' = v_win;
      tally := jsonb_set(tally, array[uid], jsonb_build_object(
        'hit',    (cur->>'hit')::int + (case when v_hit then 1 else 0 end),
        'total',  (cur->>'total')::int + 1,
        'pts',    (cur->>'pts')::int + (case when not v_hit then 0 when v_upset then 2 else 1 end),
        'upsets', (cur->>'upsets')::int + (case when v_hit and v_upset then 1 else 0 end),
        'streak', case when v_hit then (cur->>'streak')::int + 1 else 0 end,
        'name',   coalesce(vote->>'name', cur->>'name'),
        'guest',  coalesce((vote->>'guest')::boolean, cur->>'guest' = 'true')));
    end loop;
  end loop;

  return coalesce((
    select jsonb_agg(x order by (x->>'pts')::int desc, (x->>'hit')::int desc, (x->>'pct')::numeric desc, x->>'name')
      from (
        select jsonb_build_object(
                 'userId', k,
                 'name', coalesce(u.display_name, v->>'name', 'Player'),
                 'guest', coalesce((v->>'guest')::boolean, false),
                 'hit', (v->>'hit')::int,
                 'total', (v->>'total')::int,
                 'pts', (v->>'pts')::int,
                 'upsets', (v->>'upsets')::int,
                 'streak', (v->>'streak')::int,
                 'pct', round(((v->>'hit')::numeric / nullif((v->>'total')::numeric,0)) * 100)) x
          from jsonb_each(tally) e(k, v)
          left join users u on k ~ '^[0-9a-f-]{36}$' and u.id::text = k and u.community_id = v_comm
         where (v->>'total')::int > 0) q), '[]'::jsonb);
end $function$;
