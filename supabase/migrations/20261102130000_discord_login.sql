-- Sign in with Discord, onto the account the player already has.
--
-- Every existing account signs in by email, and most have connected Discord
-- separately (player_contacts.discord_user_id). Supabase's own Discord provider
-- only knows about accounts it created, so it would hand those players a second,
-- empty account. api/discord-oauth.js verifies the Discord account itself and uses
-- this lookup to find who that is. Accounts created there keep their Discord id in
-- app_metadata, which only the server can write.

-- Who is this Discord account? Returns { id, email } for a known account,
-- { email_exists: true } when the email already has an account that never connected
-- this Discord (signing them in would trust an unconfirmed email), or {} for someone new.
create function public.volt_discord_login_lookup(p_discord_id text, p_email text default null) returns jsonb
  language plpgsql stable security definer set search_path to 'public' as $$
declare v_id uuid; v_email text;
begin
  select a.id, a.email into v_id, v_email
    from player_contacts pc
    join auth.users a on a.id = pc.user_id
   where pc.discord_user_id = p_discord_id
   order by pc.updated_at desc limit 1;
  if v_id is null then
    select a.id, a.email into v_id, v_email
      from auth.users a
     where a.raw_app_meta_data->>'discord_id' = p_discord_id
     order by a.created_at desc limit 1;
  end if;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'email', v_email);
  end if;
  if p_email is not null and exists (select 1 from auth.users a where lower(a.email) = lower(p_email)) then
    return jsonb_build_object('email_exists', true);
  end if;
  return '{}'::jsonb;
end $$;
revoke execute on function public.volt_discord_login_lookup(text, text) from public, anon, authenticated;
grant  execute on function public.volt_discord_login_lookup(text, text) to service_role;

-- Link the Discord account they signed in with to the leagues they're in.
create or replace function public.volt_link_discord_from_auth() returns jsonb
  language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid := auth.uid(); v_did text; v_handle text; v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select a.raw_app_meta_data->>'discord_id', a.raw_app_meta_data->>'discord_handle'
    into v_did, v_handle
    from auth.users a where a.id = v_uid;
  if v_did is null then return jsonb_build_object('linked', false, 'reason', 'no_discord_identity'); end if;
  select community_id into v_comm from users where id = v_uid and is_active;
  if v_comm is null then return jsonb_build_object('linked', false, 'reason', 'no_league'); end if;
  return volt_discord_link_oauth(v_uid, v_did, v_handle) || jsonb_build_object('linked', true, 'handle', v_handle);
end $$;

-- A player who signed up with Discord is named after their Discord account.
create or replace function public.volt_add_member(p_user uuid, p_comm uuid, p_display text default null) returns void
  language plpgsql security definer set search_path to 'public' as $$
declare v_name text; c record;
begin
  if exists (select 1 from users where id = p_user and community_id = p_comm) then return; end if;

  select display_name into v_name from users where id = p_user order by is_active desc limit 1;
  v_name := coalesce(nullif(trim(p_display), ''), v_name,
    (select coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)) from auth.users u where u.id = p_user),
    'Player');

  insert into users (id, community_id, role, display_name, is_active)
  values (p_user, p_comm, 'player', v_name, not exists (select 1 from users where id = p_user));

  insert into player_profiles (user_id, community_id, ign, rank, rank_div, peak_rank, peak_rank_div,
                               role, agent, kda, acs, hs, win, tracker_url, discord, updated_at)
  select user_id, p_comm, ign, rank, rank_div, peak_rank, peak_rank_div,
         role, agent, kda, acs, hs, win, tracker_url, discord, now()
    from player_profiles
   where user_id = p_user and community_id <> p_comm
   order by updated_at desc limit 1
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
end $$;
