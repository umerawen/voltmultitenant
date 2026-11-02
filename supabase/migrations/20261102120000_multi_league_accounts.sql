-- One account, many leagues.
--
-- Until now an account belonged to exactly one league (users.id was the primary
-- key), so joining a second league moved you out of the first: your profile went
-- with you and your WhatsApp and Discord link were deleted.
--
-- Now public.users holds one row per (account, league). Role, display name,
-- suspensions and trophies were already league-scoped in meaning, and now are in
-- fact. is_active marks the league the account is currently looking at, which is
-- what auth_community_id() returns, so every existing RLS policy keeps working.
--
-- The read policies only return the caller's active row, so a client asking for
-- "my row" still gets exactly one.

-- ── Safety copy of what this reshapes (private schema, no API access) ───────
create schema if not exists backup_20261102;
revoke all on schema backup_20261102 from public, anon, authenticated;
create table backup_20261102.users as table public.users;
create table backup_20261102.player_profiles as table public.player_profiles;
create table backup_20261102.player_contacts as table public.player_contacts;

-- ── Table shape ─────────────────────────────────────────────────────────────
alter table public.users add column is_active boolean not null default true;

-- These pointed at users(id), which is no longer unique. They keep the same
-- delete behaviour, now from the account itself.
alter table public.match_results  drop constraint match_results_user_id_fkey,
  add constraint match_results_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;
alter table public.notifications  drop constraint notifications_user_id_fkey,
  add constraint notifications_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.player_profiles drop constraint player_profiles_user_id_fkey,
  add constraint player_profiles_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.push_tokens    drop constraint push_tokens_user_id_fkey,
  add constraint push_tokens_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.registrations  drop constraint registrations_user_id_fkey,
  add constraint registrations_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.team_players   drop constraint team_players_user_id_fkey,
  add constraint team_players_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.teams          drop constraint teams_captain_user_id_fkey,
  add constraint teams_captain_user_id_fkey foreign key (captain_user_id) references auth.users(id) on delete cascade;

alter table public.users drop constraint users_pkey,
  add constraint users_pkey primary key (id, community_id);
create unique index users_one_active on public.users (id) where is_active;

alter table public.player_profiles drop constraint player_profiles_pkey,
  add constraint player_profiles_pkey primary key (user_id, community_id);

-- ── Moving leagues no longer exists, so neither does its trigger ─────────────
drop trigger users_move_player_data on public.users;
drop function public.fn_move_player_data();

-- ── Who am I, right now ─────────────────────────────────────────────────────
create or replace function public.auth_community_id() returns uuid
  language sql stable security definer set search_path to 'public' as $$
  select community_id from users where id = auth.uid() and is_active
$$;
create or replace function public.auth_is_host() returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from users where id = auth.uid() and is_active and role = 'host')
$$;
create or replace function public.auth_is_staff() returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from users where id = auth.uid() and is_active and role in ('host','moderator'))
$$;

-- ── Row guard ───────────────────────────────────────────────────────────────
-- Staff powers are checked against the league of the row being changed. Checking
-- the caller's active league would let a host of one league promote themselves
-- in another.
create or replace function public.fn_guard_user_privileges() returns trigger
  language plpgsql security definer set search_path to 'public' as $$
declare v_host boolean; v_staff boolean;
begin
  -- No JWT = server/cron context; leave it alone.
  if auth.uid() is null then return new; end if;

  if new.id is distinct from old.id or new.community_id is distinct from old.community_id then
    raise exception 'a membership can''t be moved to another account or league';
  end if;

  if new.is_active is distinct from old.is_active
     and coalesce(current_setting('volt.switching_league', true), '') <> '1' then
    raise exception 'switch leagues with volt_switch_league';
  end if;

  select role::text = 'host', role::text in ('host','moderator') into v_host, v_staff
    from users where id = auth.uid() and community_id = new.community_id;

  -- Granting a staff role is the owner's call alone. Dropping to 'player' is
  -- always allowed.
  if new.role is distinct from old.role
     and new.role::text <> 'player'
     and not coalesce(v_host, false) then
    raise exception 'only the league host can grant staff roles';
  end if;

  -- Records and bans are league-managed. Staff write these (a moderator marking
  -- a no-show fires fn_no_show_penalty); players must never edit their own.
  if (new.suspension_remaining is distinct from old.suspension_remaining
      or new.trophy_streak    is distinct from old.trophy_streak
      or new.best_streak      is distinct from old.best_streak
      or new.weekends_won     is distinct from old.weekends_won
      or new.brackets_won     is distinct from old.brackets_won)
     and not coalesce(v_staff, false) then
    raise exception 'suspensions and season records are managed by the league';
  end if;

  return new;
end $$;

-- ── Policies ────────────────────────────────────────────────────────────────
-- users_read (community_id = auth_community_id()) already covers the caller's
-- active row. users_read_self would also return their other leagues' rows.
drop policy users_read_self on public.users;
-- Joining goes through volt_join_league. This policy let any account insert
-- itself into any league with any role, including host.
drop policy users_self_insert on public.users;
drop policy users_self_update on public.users;
create policy users_self_update on public.users for update to public
  using (id = auth.uid() and community_id = auth_community_id())
  with check (id = auth.uid() and community_id = auth_community_id());

-- FOR ALL also applied to SELECT, which would hand back every league's profile.
drop policy pp_write_self on public.player_profiles;
create policy pp_insert on public.player_profiles for insert to public
  with check ((user_id = auth.uid() or auth_is_staff()) and community_id = auth_community_id());
create policy pp_update on public.player_profiles for update to public
  using ((user_id = auth.uid() or auth_is_staff()) and community_id = auth_community_id())
  with check ((user_id = auth.uid() or auth_is_staff()) and community_id = auth_community_id());
create policy pp_delete on public.player_profiles for delete to public
  using ((user_id = auth.uid() or auth_is_staff()) and community_id = auth_community_id());

-- ── Scope every "this account's row" lookup to one league ────────────────────
-- Each call swaps an exact piece of the live function and aborts the migration
-- if that text isn't there exactly n times.
create function pg_temp.patch(p_fn text, p_from text, p_to text, p_n int default 1) returns void
  language plpgsql as $$
declare r record; v_def text; v_count int; v_hits int := 0;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = p_fn loop
    v_def := pg_get_functiondef(r.oid);
    v_count := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
    if v_count > 0 then
      if v_count <> p_n then
        raise exception 'patch %: expected % of [%], found %', p_fn, p_n, p_from, v_count;
      end if;
      execute replace(v_def, p_from, p_to);
      v_hits := v_hits + 1;
    end if;
  end loop;
  if v_hits = 0 then raise exception 'patch %: [%] not found', p_fn, p_from; end if;
end $$;

-- The caller's league, for functions that act on "my league".
select pg_temp.patch('volt_discord_link_code', 'select community_id into v_comm from users where id = v_uid;',
  'select community_id into v_comm from users where id = v_uid and is_active;');
select pg_temp.patch('volt_link_discord_from_auth', 'select community_id into v_comm from users where id = v_uid;',
  'select community_id into v_comm from users where id = v_uid and is_active;');
select pg_temp.patch('volt_push_register', 'select community_id into v_comm from users where id = auth.uid();',
  'select community_id into v_comm from users where id = auth.uid() and is_active;');
select pg_temp.patch('volt_get_discord', 'where u.id = v_uid and u.role::text in (''host'',''moderator'');',
  'where u.id = v_uid and u.is_active and u.role::text in (''host'',''moderator'');');
select pg_temp.patch('volt_set_discord', 'select community_id into v_comm from users where id = v_uid and role::text = ''host'';',
  'select community_id into v_comm from users where id = v_uid and is_active and role::text = ''host'';');
select pg_temp.patch('volt_transfer_ownership', 'select community_id into v_comm from users where id = v_uid and role::text = ''host'';',
  'select community_id into v_comm from users where id = v_uid and is_active and role::text = ''host'';');
select pg_temp.patch('volt_set_player_role', 'where id = v_uid and role::text in (''host'',''moderator'');',
  'where id = v_uid and is_active and role::text in (''host'',''moderator'');');
select pg_temp.patch('volt_set_signup_channel', 'where id = v_uid and role::text in (''host'',''moderator'');',
  'where id = v_uid and is_active and role::text in (''host'',''moderator'');');
select pg_temp.patch('volt_set_request_note', 'where id = auth.uid() and role::text = ''host'';',
  'where id = auth.uid() and is_active and role::text = ''host'';');

-- Someone's name, trophies or ban in the league in question.
select pg_temp.patch('trg_log_registration_event', 'select display_name into v_name from users where id = coalesce(NEW.user_id, OLD.user_id);',
  'select display_name into v_name from users where id = coalesce(NEW.user_id, OLD.user_id) and community_id = coalesce(NEW.community_id, OLD.community_id);');
select pg_temp.patch('volt_apply', 'select display_name into v_name from users where id = v_uid;',
  'select display_name into v_name from users where id = v_uid and community_id = v_comm;');
select pg_temp.patch('volt_auctioneer', '(select display_name from users where id = v_a)',
  '(select display_name from users where id = v_a and community_id = v_comm)');
select pg_temp.patch('volt_availability_summary', 'from users u where u.id = any(v_blocked)',
  'from users u where u.id = any(v_blocked) and u.community_id = v_comm');
select pg_temp.patch('volt_dc_me', '(select weekends_won from users where id = v.user_id)',
  '(select weekends_won from users where id = v.user_id and community_id = v.community_id)');
select pg_temp.patch('volt_dc_me', '(select trophy_streak from users where id = v.user_id)',
  '(select trophy_streak from users where id = v.user_id and community_id = v.community_id)');
select pg_temp.patch('volt_dc_predict', 'select display_name into v_name from users where id = v.user_id;',
  'select display_name into v_name from users where id = v.user_id and community_id = v.community_id;');
select pg_temp.patch('volt_dc_withdraw', 'select display_name into v_name from users where id = v.user_id;',
  'select display_name into v_name from users where id = v.user_id and community_id = v.community_id;');
select pg_temp.patch('volt_dc_register', 'select suspension_remaining into v_susp from users where id = v.user_id;',
  'select suspension_remaining into v_susp from users where id = v.user_id and community_id = v.community_id;');
select pg_temp.patch('volt_discord_redeem', '(select display_name from users where id = r.user_id)',
  '(select display_name from users where id = r.user_id and community_id = r.community_id)');
select pg_temp.patch('volt_log_event', 'select display_name into v_name from users where id = p_subject;',
  'select display_name into v_name from users where id = p_subject and community_id = v_comm;');
select pg_temp.patch('volt_log_event', 'select display_name into v_actor from users where id = v_uid;',
  'select display_name into v_actor from users where id = v_uid and community_id = v_comm;');
select pg_temp.patch('volt_pred_standings', 'and u.id::text = k', 'and u.id::text = k and u.community_id = v_comm');
select pg_temp.patch('volt_sub_eligible', '(select suspension_remaining from users where id = u.id)',
  '(select suspension_remaining from users where id = u.id and community_id = v_comm)');
select pg_temp.patch('volt_sub_fill', 'select display_name into v_name from users where id = p_user;',
  'select display_name into v_name from users where id = p_user and community_id = r.community_id;');
select pg_temp.patch('volt_sub_request', 'select display_name into v_name from users where id = p_out;',
  'select display_name into v_name from users where id = p_out and community_id = v_comm;');
select pg_temp.patch('fn_no_show_penalty', 'UPDATE users SET suspension_remaining = 2 WHERE id = NEW.user_id;',
  'UPDATE users SET suspension_remaining = 2 WHERE id = NEW.user_id AND community_id = NEW.community_id;');
select pg_temp.patch('fn_no_show_penalty', 'WHERE id = NEW.user_id AND suspension_remaining > 0;',
  'WHERE id = NEW.user_id AND community_id = NEW.community_id AND suspension_remaining > 0;');

-- Joins that would return one row per league the player is in.
select pg_temp.patch('volt_availability_summary', 'join users u on u.id = r.user_id',
  'join users u on u.id = r.user_id and u.community_id = r.community_id', 3);
select pg_temp.patch('volt_board_gap', 'join users u on u.id = r.user_id',
  'join users u on u.id = r.user_id and u.community_id = r.community_id');
select pg_temp.patch('volt_dc_role_members', 'join users u on u.id = r.user_id',
  'join users u on u.id = r.user_id and u.community_id = r.community_id');
select pg_temp.patch('volt_dc_rollcall', 'join users u on u.id = r.user_id',
  'join users u on u.id = r.user_id and u.community_id = r.community_id');
select pg_temp.patch('volt_dc_subs', 'join users u on u.id = r.user_id',
  'join users u on u.id = r.user_id and u.community_id = r.community_id');
select pg_temp.patch('volt_ign_check', 'join users u on u.id = r.user_id',
  'join users u on u.id = r.user_id and u.community_id = r.community_id');
select pg_temp.patch('volt_sub_eligible', 'join users u on u.id = r.user_id',
  'join users u on u.id = r.user_id and u.community_id = r.community_id');
select pg_temp.patch('volt_unlinked', 'join users u on u.id = r.user_id',
  'join users u on u.id = r.user_id and u.community_id = r.community_id');
select pg_temp.patch('volt_sub_open', 'join users u on u.id = o.user_id',
  'join users u on u.id = o.user_id and u.community_id = r.community_id');

-- Profiles are per league now.
select pg_temp.patch('volt_discord_redeem', 'on conflict (user_id) do update', 'on conflict (user_id, community_id) do update');

-- With no guild to go on (a bot DM), answer for the league they're looking at.
select pg_temp.patch('volt_dc_user', 'limit 1;', 'order by u.is_active desc limit 1;');

-- ── Joining and switching ───────────────────────────────────────────────────
-- Make an account's league the active one. Internal: callers check membership.
create function public.volt_set_active_league(p_user uuid, p_comm uuid) returns void
  language plpgsql security definer set search_path to 'public' as $$
begin
  perform set_config('volt.switching_league', '1', true);
  update users set is_active = false where id = p_user and is_active and community_id <> p_comm;
  update users set is_active = true  where id = p_user and community_id = p_comm and not is_active;
  perform set_config('volt.switching_league', '0', true);
end $$;

-- Add an account to a league, bringing its player card, WhatsApp and Discord
-- link along from wherever it was most recently updated. Points, trophies, strikes
-- and role all start fresh: each league keeps its own.
create function public.volt_add_member(p_user uuid, p_comm uuid, p_display text default null) returns void
  language plpgsql security definer set search_path to 'public' as $$
declare v_name text; c record;
begin
  if exists (select 1 from users where id = p_user and community_id = p_comm) then return; end if;

  select display_name into v_name from users where id = p_user order by is_active desc limit 1;
  v_name := coalesce(nullif(trim(p_display), ''), v_name,
    (select regexp_replace(coalesce(i.identity_data->>'name', i.identity_data->>'full_name'), '#0$', '')
       from auth.identities i where i.user_id = p_user order by i.created_at desc limit 1),
    (select split_part(u.email, '@', 1) from auth.users u where u.id = p_user),
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

-- Join a league by its code, or just move to it if already in. Re-using a code
-- is never harmful: it can't demote a host or reset anything.
create function public.volt_join_league(p_slug text, p_display text default null) returns jsonb
  language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid := auth.uid(); v_comm communities; v_new boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_comm from communities
   where lower(slug) = lower(trim(p_slug)) and status = 'approved' limit 1;
  if v_comm.id is null then raise exception 'No league found with that code. Check with your host.'; end if;
  v_new := not exists (select 1 from users where id = v_uid and community_id = v_comm.id);
  perform volt_add_member(v_uid, v_comm.id, p_display);
  perform volt_set_active_league(v_uid, v_comm.id);
  return jsonb_build_object('id', v_comm.id, 'name', v_comm.name, 'slug', v_comm.slug, 'joined', v_new);
end $$;

create function public.volt_switch_league(p_community uuid) returns void
  language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = p_community) then
    raise exception 'You''re not in that league.';
  end if;
  perform volt_set_active_league(v_uid, p_community);
end $$;

-- What the league switcher shows: every league this account is in, what's
-- happening in each, and the player card that gets carried into a new one.
create function public.volt_my_leagues() returns jsonb
  language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'leagues', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'slug', c.slug, 'status', c.status,
               'role', u.role::text, 'active', u.is_active,
               'phase', ev.phase, 'label', ev.weekend_label, 'draftAt', ev.draft_at,
               'unread', (select count(*) from notifications n
                           where n.user_id = u.id and n.community_id = c.id and not n.read))
             order by u.is_active desc, c.name)
        from users u
        join communities c on c.id = u.community_id
        left join lateral (
          select e.phase::text as phase, e.weekend_label, e.draft_at
            from events e
           where e.community_id = c.id and e.phase <> 'settled'
           order by case e.phase::text when 'matches_live' then 0 when 'drafting' then 1
                                       when 'registration_open' then 2 when 'registration_closed' then 3 else 4 end,
                    e.created_at desc
           limit 1) ev on true
       where u.id = auth.uid()), '[]'::jsonb),
    'card', (
      select jsonb_build_object('name', u.display_name, 'ign', p.ign, 'rank', p.rank, 'rankDiv', p.rank_div,
                                'role', p.role, 'agent', p.agent)
        from users u
        left join player_profiles p on p.user_id = u.id and p.community_id = u.community_id
       where u.id = auth.uid() and u.is_active))
$$;

-- A league creator gets a new membership and keeps every league they're already in.
create or replace function public.create_league(p_name text, p_slug text, p_display text) returns json
  language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_status text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  -- An operator spinning up their own league shouldn't have to approve it.
  v_status := case when is_platform_admin() then 'approved' else 'pending' end;
  insert into communities (name, slug, status) values (p_name, p_slug, v_status)
    returning communities.id into v_id;
  insert into users (id, community_id, role, display_name, is_active)
    values (v_uid, v_id, 'host', coalesce(nullif(p_display,''), 'Host'), false);
  perform volt_set_active_league(v_uid, v_id);
  return json_build_object('id', v_id, 'name', p_name, 'slug', p_slug, 'status', v_status);
end $$;

-- ── Discord ─────────────────────────────────────────────────────────────────
-- One Discord account, linked in every league the player is in.
create or replace function public.volt_discord_link_oauth(p_user uuid, p_discord_id text, p_handle text) returns jsonb
  language plpgsql security definer set search_path to 'public' as $$
declare v_comm uuid; v_any boolean := false;
begin
  for v_comm in select community_id from users where id = p_user loop
    v_any := true;
    update player_contacts set discord_user_id = null
     where community_id = v_comm and discord_user_id = p_discord_id and user_id <> p_user;

    insert into player_contacts (user_id, community_id, discord_user_id)
    values (p_user, v_comm, p_discord_id)
    on conflict (user_id, community_id) do update set discord_user_id = excluded.discord_user_id;

    if p_handle is not null then
      insert into player_profiles (user_id, community_id, discord, updated_at)
      values (p_user, v_comm, p_handle, now())
      on conflict (user_id, community_id) do update set discord = excluded.discord, updated_at = now();
    end if;
  end loop;
  if not v_any then return jsonb_build_object('ok', false, 'error', 'not in a league'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- "Already signed up? Add me" pressed in a server whose league this person isn't
-- in yet, by someone VOLT knows from another league: bring them in. Only trusted
-- server code reaches this, with a Discord id Discord itself vouched for.
create function public.volt_dc_auto_join(p_guild text, p_discord_id text) returns boolean
  language plpgsql security definer set search_path to 'public' as $$
declare v_comm uuid; v_user uuid;
begin
  select id into v_comm from communities where discord_guild_id = p_guild and status = 'approved';
  if v_comm is null then return false; end if;
  select pc.user_id into v_user from player_contacts pc
    join users u on u.id = pc.user_id and u.community_id = pc.community_id
   where pc.discord_user_id = p_discord_id
   order by pc.updated_at desc limit 1;
  if v_user is null then
    select i.user_id into v_user from auth.identities i
      join users u on u.id = i.user_id
     where i.provider = 'discord' and i.provider_id = p_discord_id
     order by i.created_at desc limit 1;
  end if;
  if v_user is null then return false; end if;
  perform volt_add_member(v_user, v_comm, null);
  -- volt_dc_user finds them through this row, so it can't depend on the copy.
  insert into player_contacts (user_id, community_id, discord_user_id)
  values (v_user, v_comm, p_discord_id)
  on conflict (user_id, community_id) do update set discord_user_id = excluded.discord_user_id;
  perform volt_set_active_league(v_user, v_comm);
  return true;
end $$;

select pg_temp.patch('volt_dc_register', 'return jsonb_build_object(''error'',''link'', ''league'', v_league);',
  'perform volt_dc_auto_join(p_guild, p_discord_id);
    select * into v from volt_dc_user(p_guild, p_discord_id);
    if v is null then
      return jsonb_build_object(''error'',''link'', ''league'', v_league);
    end if;');

-- ── Who may call what ───────────────────────────────────────────────────────
revoke execute on function public.volt_set_active_league(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.volt_add_member(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.volt_dc_auto_join(text, text) from public, anon, authenticated;
grant  execute on function public.volt_dc_auto_join(text, text) to service_role;
revoke execute on function public.volt_join_league(text, text) from public, anon;
grant  execute on function public.volt_join_league(text, text) to authenticated;
revoke execute on function public.volt_switch_league(uuid) from public, anon;
grant  execute on function public.volt_switch_league(uuid) to authenticated;
revoke execute on function public.volt_my_leagues() from public, anon;
grant  execute on function public.volt_my_leagues() to authenticated;

-- ── Put back memberships the old "move" took away ───────────────────────────
-- Anyone with history in a league they're no longer a member of gets that
-- membership back, with their current card copied, so old results have a name.
do $$
declare r record;
begin
  for r in
    select distinct x.user_id, x.community_id from (
      select user_id, community_id from registrations
      union select user_id, community_id from team_players
      union select user_id, community_id from match_results where user_id is not null
      union select captain_user_id, community_id from teams) x
    where not exists (select 1 from users u where u.id = x.user_id and u.community_id = x.community_id)
      and exists (select 1 from users u where u.id = x.user_id)
  loop
    perform volt_add_member(r.user_id, r.community_id, null);
  end loop;
end $$;
