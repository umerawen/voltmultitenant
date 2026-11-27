-- Dota 2 build (the `dota` branch) shares this database with VOLT.
-- Additive only: nothing Valorant reads changes.
--
-- 1. player_profiles.steam_id — optional; the Dota build matches OpenDota
--    match stats to players by it (or by the Dotabuff link in tracker_url).
-- 2. Dota medals in the two rank helpers. Immortal already exists with the
--    same value and position (3500 / 8), so it needs no entry of its own.

alter table public.player_profiles add column if not exists steam_id text;

create or replace function public.volt_rank_bid(p_rank text)
 returns integer
 language sql
 immutable
as $function$
  select case p_rank
    when 'Iron' then 300 when 'Bronze' then 500 when 'Silver' then 800
    when 'Gold' then 1100 when 'Platinum' then 1500 when 'Diamond' then 2000
    when 'Ascendant' then 2600 when 'Immortal' then 3500 when 'Radiant' then 4500
    when 'Herald' then 300 when 'Guardian' then 500 when 'Crusader' then 800
    when 'Archon' then 1100 when 'Legend' then 1500 when 'Ancient' then 2000
    when 'Divine' then 2600
    else 800 end;
$function$;

create or replace function public.volt_rank_index(p_rank text)
 returns integer
 language sql
 immutable
as $function$
  select case p_rank
    when 'Iron' then 1 when 'Bronze' then 2 when 'Silver' then 3
    when 'Gold' then 4 when 'Platinum' then 5 when 'Diamond' then 6
    when 'Ascendant' then 7 when 'Immortal' then 8 when 'Radiant' then 9
    when 'Herald' then 1 when 'Guardian' then 2 when 'Crusader' then 3
    when 'Archon' then 4 when 'Legend' then 5 when 'Ancient' then 6
    when 'Divine' then 7
    else 3 end;
$function$;
