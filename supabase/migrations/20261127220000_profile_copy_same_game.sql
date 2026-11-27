-- Joining a league copied the player's latest profile from any other league,
-- so a Valorant profile (rank, agent, ACS, HS%) landed in a Dota league.
-- Profiles now only carry over between leagues of the same game
-- (communities.game). WhatsApp and the Discord link still carry over: they
-- aren't game-specific. steam_id rides along between Dota leagues.
create or replace function public.volt_add_member(p_user uuid, p_comm uuid, p_display text default null::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_name text; c record; v_game text;
begin
  if exists (select 1 from users where id = p_user and community_id = p_comm) then return; end if;

  select display_name into v_name from users where id = p_user order by is_active desc limit 1;
  v_name := coalesce(nullif(trim(p_display), ''), v_name,
    (select coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)) from auth.users u where u.id = p_user),
    'Player');

  insert into users (id, community_id, role, display_name, is_active)
  values (p_user, p_comm, 'player', v_name, not exists (select 1 from users where id = p_user));

  select game into v_game from communities where id = p_comm;
  insert into player_profiles (user_id, community_id, ign, rank, rank_div, peak_rank, peak_rank_div,
                               role, agent, kda, acs, hs, win, tracker_url, discord, steam_id, updated_at)
  select pp.user_id, p_comm, pp.ign, pp.rank, pp.rank_div, pp.peak_rank, pp.peak_rank_div,
         pp.role, pp.agent, pp.kda, pp.acs, pp.hs, pp.win, pp.tracker_url, pp.discord, pp.steam_id, now()
    from player_profiles pp
    join communities src on src.id = pp.community_id
   where pp.user_id = p_user and pp.community_id <> p_comm
     and src.game = coalesce(v_game, 'valorant')
   order by pp.updated_at desc limit 1
  on conflict (user_id, community_id) do nothing;

  select whatsapp, discord_user_id into c from player_contacts
   where user_id = p_user and community_id <> p_comm
   order by (discord_user_id is not null) desc, (whatsapp is not null) desc, updated_at desc limit 1;
  if found and (c.whatsapp is not null or c.discord_user_id is not null) then
    -- One Discord account can only belong to one player in a league.
    if c.discord_user_id is not null then
      update player_contacts set discord_user_id = null
       where community_id = p_comm and discord_user_id = c.discord_user_id and user_id <> p_user;
    end if;
    insert into player_contacts (user_id, community_id, whatsapp, discord_user_id)
    values (p_user, p_comm, c.whatsapp, c.discord_user_id)
    on conflict (user_id, community_id) do nothing;
  end if;
end $function$;
