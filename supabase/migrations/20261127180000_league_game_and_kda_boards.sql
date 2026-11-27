-- Which game a league plays. Everything Valorant reads keeps its default;
-- the Discord bot switches its wording (and the Dota rankings below) on it.
alter table public.communities add column if not exists game text not null default 'valorant';

-- Two more sorts for the Discord leaderboard, used by Dota leagues:
--   'kills'   — average kills per game, fewer deaths breaking ties
--   'assists' — average assists per game (the support board), same tie-break
-- Each row also carries avgK / avgD / avgA. The existing sorts are unchanged.
create or replace function public.volt_dc_leaderboard(p_guild text, p_sort text default 'acs')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_comm uuid;
  v_by_pts boolean := (p_sort = 'pts');
  v_by_k boolean := (p_sort = 'kills');
  v_by_a boolean := (p_sort = 'assists');
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  return coalesce((
    select jsonb_agg(x)
      from (
        select jsonb_build_object(
                 'name', u.display_name,
                 'avgPerf', round(avg(volt_perf(m.stat_payload)) filter (where volt_did_play(m.stat_payload))),
                 'avgAcs',  round(avg(volt_perf(m.stat_payload)) filter (where volt_did_play(m.stat_payload))),
                 'avgK', round(avg(coalesce((m.stat_payload->>'k')::numeric, 0)) filter (where volt_did_play(m.stat_payload)), 1),
                 'avgD', round(avg(coalesce((m.stat_payload->>'d')::numeric, 0)) filter (where volt_did_play(m.stat_payload)), 1),
                 'avgA', round(avg(coalesce((m.stat_payload->>'a')::numeric, 0)) filter (where volt_did_play(m.stat_payload)), 1),
                 'played', count(*) filter (where volt_did_play(m.stat_payload)),
                 'wins',   count(*) filter (where m.team_won and volt_did_play(m.stat_payload)),
                 'pts',    round(coalesce(sum(m.points_computed),0)),
                 'sort',   p_sort) x
          from users u
          join match_results m on m.user_id = u.id and m.community_id = v_comm
         where u.community_id = v_comm
         group by u.id, u.display_name
         having count(*) filter (where volt_did_play(m.stat_payload)) > 0
         order by
           case when v_by_k then avg(coalesce((m.stat_payload->>'k')::numeric, 0)) filter (where volt_did_play(m.stat_payload)) end desc nulls last,
           case when v_by_a then avg(coalesce((m.stat_payload->>'a')::numeric, 0)) filter (where volt_did_play(m.stat_payload)) end desc nulls last,
           case when v_by_k or v_by_a then avg(coalesce((m.stat_payload->>'d')::numeric, 0)) filter (where volt_did_play(m.stat_payload)) end asc nulls last,
           case when v_by_pts then round(coalesce(sum(m.points_computed),0)) end desc nulls last,
           case when v_by_pts then round(avg(volt_perf(m.stat_payload))
                                         filter (where volt_did_play(m.stat_payload))) end desc nulls last,
           case when not v_by_pts then round(avg(volt_perf(m.stat_payload))
                                              filter (where volt_did_play(m.stat_payload))) end desc nulls last,
           case when not v_by_pts then round(coalesce(sum(m.points_computed),0)) end desc nulls last,
           count(*) filter (where volt_did_play(m.stat_payload)) desc
         limit 25) q), '[]'::jsonb);
end $function$;
