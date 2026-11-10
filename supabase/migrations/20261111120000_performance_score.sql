-- Valorant patch 13.06 (Sept 2026) replaced ACS on the end-of-match
-- scoreboard with Performance Score, a 0-500 rating. Match stats reported from
-- now on carry it as stat_payload.ps; rows reported before the switch only
-- have stat_payload.acs. Tracker profiles (player_profiles.acs) are still ACS
-- and are untouched here.
--
-- One reading rule everywhere: performance score where it was recorded, the
-- old ACS otherwise. The two share a 0-500 range, so a season that spans the
-- switch averages sensibly.

create or replace function public.volt_perf(p_stats jsonb)
returns numeric
language sql
immutable
as $$
  select coalesce(nullif(p_stats->>'ps', '')::numeric, nullif(p_stats->>'acs', '')::numeric, 0);
$$;

-- A row of all zeros is someone rostered who didn't play.
create or replace function public.volt_did_play(p_stats jsonb)
returns boolean
language sql
immutable
as $$
  select volt_perf(p_stats) > 0
      or coalesce((p_stats->>'k')::numeric, 0) > 0
      or coalesce((p_stats->>'a')::numeric, 0) > 0
      or coalesce((p_stats->>'d')::numeric, 0) > 0;
$$;

-- Season leaderboard for the Discord bot. p_sort 'acs' (the slash command's
-- stored value) and 'perf' both rank by average performance. avgAcs is kept
-- alongside avgPerf, same value, so a bot build from before this change still
-- prints a number.
create or replace function public.volt_dc_leaderboard(p_guild text, p_sort text default 'acs')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_comm uuid; v_by_pts boolean := (p_sort = 'pts');
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
                 'played', count(*) filter (where volt_did_play(m.stat_payload)),
                 'wins',   count(*) filter (where m.team_won and volt_did_play(m.stat_payload)),
                 'pts',    round(coalesce(sum(m.points_computed),0)),
                 'sort',   p_sort) x
          from users u
          join match_results m on m.user_id = u.id and m.community_id = v_comm
         where u.community_id = v_comm
         group by u.id, u.display_name
         having count(*) filter (where volt_did_play(m.stat_payload)) > 0
         -- Sort before the limit, and tie-break on the other metric.
         order by
           case when v_by_pts then round(coalesce(sum(m.points_computed),0)) end desc nulls last,
           case when v_by_pts then round(avg(volt_perf(m.stat_payload))
                                         filter (where volt_did_play(m.stat_payload))) end desc nulls last,
           case when not v_by_pts then round(avg(volt_perf(m.stat_payload))
                                              filter (where volt_did_play(m.stat_payload))) end desc nulls last,
           case when not v_by_pts then round(coalesce(sum(m.points_computed),0)) end desc nulls last,
           count(*) filter (where volt_did_play(m.stat_payload)) desc
         limit 25) q), '[]'::jsonb);
end $function$;

-- The bot calls this with the service key only (it takes a guild id).
revoke execute on function public.volt_dc_leaderboard(text, text) from public, anon, authenticated;
grant execute on function public.volt_dc_leaderboard(text, text) to service_role;
