-- ════════════════════════════════════════════════════════════════════
-- VOLT League — full database schema (snapshot of the LIVE Supabase project)
--
-- Snapshot taken 2026-10-03 from project "volt multi tenant"
-- (ref fuelqjfyiqppxrdmmscu). Before this, the repo's schema.sql dated from
-- June and was missing most tables and every volt_* function.
--
-- Rebuilding from scratch: run this whole file in the Supabase SQL editor,
-- then run each file in supabase/migrations/ in name order.
--
-- From now on: every database change goes in a new file under
-- supabase/migrations/ (and gets applied to Supabase), so the repo never
-- falls behind the live database again.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ── Types ────────────────────────────────────────────────────────────
create type public.user_role as enum ('host', 'player', 'moderator');
create type public.sub_status as enum ('pending', 'trialing', 'active', 'past_due', 'canceled');
create type public.season_status as enum ('upcoming', 'active', 'completed');
create type public.event_phase as enum ('registration_open', 'registration_closed', 'drafting', 'matches_live', 'settled');

create sequence if not exists public.volt_pulse_id_seq;

-- ── Tables ───────────────────────────────────────────────────────────
create table public.communities (
  id uuid default gen_random_uuid() not null,
  name text not null,
  slug text not null,
  subscription_status sub_status default 'pending'::sub_status not null,
  created_at timestamp with time zone default now() not null,
  name_map jsonb default '{}'::jsonb not null,
  discord_guild_id text,
  discord_channel_id text,
  timezone text default 'UTC'::text not null,
  discord_signup_channel_id text,
  discord_role_id text,
  discord_role_name text,
  status text default 'approved'::text not null,
  requested_note text,
  reviewed_at timestamp with time zone,
  constraint communities_pkey PRIMARY KEY (id),
  constraint communities_discord_guild_uniq UNIQUE (discord_guild_id),
  constraint communities_slug_key UNIQUE (slug),
  constraint communities_status_ck CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'suspended'::text])))
);

create table public.users (
  id uuid not null,
  community_id uuid not null,
  role user_role default 'player'::user_role not null,
  display_name text not null,
  wants_captain boolean default false not null,
  created_at timestamp with time zone default now() not null,
  suspension_remaining integer default 0 not null,
  trophy_streak integer default 0 not null,
  best_streak integer default 0 not null,
  weekends_won integer default 0 not null,
  brackets_won integer default 0 not null,
  constraint users_pkey PRIMARY KEY (id)
);

create table public.seasons (
  id uuid default gen_random_uuid() not null,
  community_id uuid not null,
  name text not null,
  status season_status default 'upcoming'::season_status not null,
  starts_at date,
  ends_at date,
  created_at timestamp with time zone default now() not null,
  constraint seasons_pkey PRIMARY KEY (id)
);

create table public.events (
  id uuid default gen_random_uuid() not null,
  season_id uuid not null,
  community_id uuid not null,
  weekend_label text,
  phase event_phase default 'registration_open'::event_phase not null,
  phase_overridden boolean default false not null,
  reg_opens timestamp with time zone,
  reg_closes timestamp with time zone,
  draft_at timestamp with time zone,
  matches_start timestamp with time zone,
  matches_end timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  recap jsonb,
  starts_on date,
  ends_on date,
  draft_reminder_at timestamp with time zone,
  availability_check_at timestamp with time zone,
  auctioneer_id uuid,
  availability_blocked uuid[],
  constraint events_pkey PRIMARY KEY (id)
);

create table public.registrations (
  id uuid default gen_random_uuid() not null,
  event_id uuid not null,
  community_id uuid not null,
  user_id uuid not null,
  is_captain boolean default false not null,
  created_at timestamp with time zone default now() not null,
  rank text,
  status text default 'pending'::text not null,
  availability_confirmed boolean default false not null,
  no_show boolean default false not null,
  wants_captain boolean default false not null,
  pool_eligible boolean default true not null,
  reconfirmed_at timestamp with time zone,
  declined_at timestamp with time zone,
  no_show_at timestamp with time zone,
  constraint registrations_pkey PRIMARY KEY (id),
  constraint registrations_event_id_user_id_key UNIQUE (event_id, user_id),
  constraint regs_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

create table public.teams (
  id uuid default gen_random_uuid() not null,
  event_id uuid not null,
  community_id uuid not null,
  captain_user_id uuid not null,
  name text,
  created_at timestamp with time zone default now() not null,
  budget integer default 10000 not null,
  constraint teams_pkey PRIMARY KEY (id)
);

create table public.team_players (
  team_id uuid not null,
  user_id uuid not null,
  community_id uuid not null,
  draft_price integer default 0 not null,
  constraint team_players_pkey PRIMARY KEY (team_id, user_id)
);

create table public.match_results (
  id uuid default gen_random_uuid() not null,
  event_id uuid not null,
  community_id uuid not null,
  user_id uuid,
  team_id uuid,
  stat_payload jsonb default '{}'::jsonb not null,
  team_won boolean default false not null,
  points_computed numeric default 0 not null,
  created_at timestamp with time zone default now() not null,
  match_label text,
  player_name text default 'Player'::text not null,
  constraint match_results_pkey PRIMARY KEY (id)
);

create table public.tournaments (
  id uuid default gen_random_uuid() not null,
  season_id uuid not null,
  community_id uuid not null,
  size integer default 8 not null,
  bracket jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  constraint tournaments_pkey PRIMARY KEY (id)
);

create table public.draft_state (
  event_id uuid not null,
  community_id uuid not null,
  state jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null,
  constraint draft_state_pkey PRIMARY KEY (event_id)
);

create table public.player_profiles (
  user_id uuid not null,
  community_id uuid not null,
  rank text,
  role text,
  agent text,
  kda numeric(4,2),
  acs integer,
  hs integer,
  win integer,
  badges jsonb default '[]'::jsonb not null,
  tracker_url text,
  updated_at timestamp with time zone default now() not null,
  discord text,
  rank_div smallint,
  peak_rank text,
  peak_rank_div smallint,
  ign text,
  constraint player_profiles_pkey PRIMARY KEY (user_id),
  constraint player_profiles_peak_rank_div_ck CHECK (((peak_rank_div IS NULL) OR ((peak_rank_div >= 1) AND (peak_rank_div <= 3)))),
  constraint player_profiles_rank_div_ck CHECK (((rank_div IS NULL) OR ((rank_div >= 1) AND (rank_div <= 3))))
);

create table public.community_kv (
  community_id uuid not null,
  k text not null,
  val text not null,
  shared boolean default true not null,
  user_id uuid,
  updated_at timestamp with time zone default now() not null,
  id uuid default gen_random_uuid() not null,
  constraint community_kv_pkey PRIMARY KEY (id),
  constraint community_kv_uniq UNIQUE NULLS NOT DISTINCT (community_id, k, shared, user_id)
);

create table public.notifications (
  id uuid default gen_random_uuid() not null,
  community_id uuid not null,
  user_id uuid not null,
  event_id uuid,
  kind text not null,
  title text not null,
  body text,
  read boolean default false not null,
  created_at timestamp with time zone default now() not null,
  constraint notifications_pkey PRIMARY KEY (id)
);

-- One-off backup taken during a 2026-07-28 data fix. Not used by the app.
create table public._volt_kv_backup_20260728 (
  community_id uuid,
  k text,
  val text,
  shared boolean,
  user_id uuid,
  updated_at timestamp with time zone
);

create table public.player_contacts (
  user_id uuid not null,
  community_id uuid not null,
  whatsapp text,
  updated_at timestamp with time zone default now() not null,
  discord_user_id text,
  constraint player_contacts_pkey PRIMARY KEY (user_id, community_id)
);

create table public.discord_link_codes (
  code text not null,
  user_id uuid not null,
  community_id uuid not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone default (now() + '00:15:00'::interval) not null,
  used_at timestamp with time zone,
  constraint discord_link_codes_pkey PRIMARY KEY (code)
);

-- Server-side settings. Rows: notify_url (the /api/discord-notify URL) and
-- notify_secret (must equal VOLT_NOTIFY_SECRET in Vercel). Never commit values.
create table public.volt_config (
  k text not null,
  v text not null,
  updated_at timestamp with time zone default now() not null,
  constraint volt_config_pkey PRIMARY KEY (k)
);

create table public.league_events (
  id uuid default gen_random_uuid() not null,
  community_id uuid not null,
  event_id uuid,
  kind text not null,
  subject_user_id uuid,
  subject_name text,
  actor_name text,
  team_name text,
  amount integer,
  detail text,
  created_at timestamp with time zone default now() not null,
  constraint league_events_pkey PRIMARY KEY (id)
);

create table public.sub_requests (
  id uuid default gen_random_uuid() not null,
  community_id uuid not null,
  event_id uuid not null,
  team_name text not null,
  captain_id uuid not null,
  out_user_id uuid not null,
  out_name text,
  out_rank text,
  status text default 'open'::text not null,
  filled_user_id uuid,
  created_at timestamp with time zone default now() not null,
  constraint sub_requests_pkey PRIMARY KEY (id)
);

create table public.sub_offers (
  request_id uuid not null,
  user_id uuid not null,
  created_at timestamp with time zone default now() not null,
  constraint sub_offers_pkey PRIMARY KEY (request_id, user_id)
);

create table public.discord_objects (
  id uuid default gen_random_uuid() not null,
  community_id uuid not null,
  event_id uuid,
  kind text not null,
  ref text not null,
  discord_id text not null,
  meta jsonb,
  created_at timestamp with time zone default now() not null,
  constraint discord_objects_pkey PRIMARY KEY (id),
  constraint discord_objects_uniq UNIQUE NULLS NOT DISTINCT (community_id, event_id, kind, ref)
);

create table public.platform_admins (
  user_id uuid not null,
  note text,
  created_at timestamp with time zone default now() not null,
  constraint platform_admins_pkey PRIMARY KEY (user_id)
);

create table public.volt_pulse (
  id bigint default nextval('volt_pulse_id_seq'::regclass) not null,
  community_id uuid not null,
  payload jsonb not null,
  created_at timestamp with time zone default now() not null,
  constraint volt_pulse_pkey PRIMARY KEY (id)
);

-- ── Foreign keys ─────────────────────────────────────────────────────
alter table public.community_kv add constraint community_kv_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.discord_link_codes add constraint discord_link_codes_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.discord_link_codes add constraint discord_link_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.discord_objects add constraint discord_objects_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.draft_state add constraint draft_state_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.draft_state add constraint draft_state_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
alter table public.events add constraint events_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.events add constraint events_season_id_fkey FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE;
alter table public.league_events add constraint league_events_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.match_results add constraint match_results_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.match_results add constraint match_results_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
alter table public.match_results add constraint match_results_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
alter table public.match_results add constraint match_results_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
alter table public.notifications add constraint notifications_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.notifications add constraint notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
alter table public.notifications add constraint notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table public.player_contacts add constraint player_contacts_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.player_contacts add constraint player_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.player_profiles add constraint player_profiles_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.player_profiles add constraint player_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table public.registrations add constraint registrations_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.registrations add constraint registrations_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
alter table public.registrations add constraint registrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table public.seasons add constraint seasons_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.sub_offers add constraint sub_offers_request_id_fkey FOREIGN KEY (request_id) REFERENCES sub_requests(id) ON DELETE CASCADE;
alter table public.sub_requests add constraint sub_requests_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.team_players add constraint team_players_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.team_players add constraint team_players_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
alter table public.team_players add constraint team_players_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table public.teams add constraint teams_captain_user_id_fkey FOREIGN KEY (captain_user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table public.teams add constraint teams_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.teams add constraint teams_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
alter table public.tournaments add constraint tournaments_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.tournaments add constraint tournaments_season_id_fkey FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE;
alter table public.users add constraint users_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE;
alter table public.users add constraint users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── Indexes ──────────────────────────────────────────────────────────
CREATE INDEX community_kv_lookup ON public.community_kv USING btree (community_id, shared);
CREATE INDEX idx_dlc_user ON public.discord_link_codes USING btree (user_id);
CREATE INDEX idx_draft_state_community ON public.draft_state USING btree (community_id);
CREATE INDEX events_community_id_idx ON public.events USING btree (community_id);
CREATE INDEX events_season_id_idx ON public.events USING btree (season_id);
CREATE INDEX league_events_feed_idx ON public.league_events USING btree (community_id, created_at DESC);
CREATE UNIQUE INDEX match_results_uniq ON public.match_results USING btree (event_id, COALESCE(match_label, ''::text), COALESCE((user_id)::text, ('anon:'::text || player_name)));
CREATE INDEX match_results_event_id_idx ON public.match_results USING btree (event_id);
CREATE INDEX idx_mr_leaderboard ON public.match_results USING btree (community_id, user_id);
CREATE INDEX match_results_community_id_idx ON public.match_results USING btree (community_id);
CREATE INDEX match_results_user_id_idx ON public.match_results USING btree (user_id);
CREATE INDEX idx_match_results_team ON public.match_results USING btree (team_id);
CREATE INDEX notifications_user_unread ON public.notifications USING btree (user_id, read, created_at DESC);
CREATE INDEX idx_notifications_event ON public.notifications USING btree (event_id);
CREATE INDEX idx_notifications_user_read ON public.notifications USING btree (user_id, read, created_at DESC);
CREATE INDEX idx_notifications_community ON public.notifications USING btree (community_id);
CREATE INDEX idx_player_contacts_comm ON public.player_contacts USING btree (community_id);
CREATE INDEX idx_player_profiles_community ON public.player_profiles USING btree (community_id);
CREATE INDEX registrations_community_id_idx ON public.registrations USING btree (community_id);
CREATE INDEX idx_registrations_user ON public.registrations USING btree (user_id);
CREATE INDEX registrations_event_id_idx ON public.registrations USING btree (event_id);
CREATE INDEX seasons_community_id_idx ON public.seasons USING btree (community_id);
CREATE INDEX sub_requests_open_idx ON public.sub_requests USING btree (community_id, status, created_at DESC);
CREATE INDEX team_players_community_id_idx ON public.team_players USING btree (community_id);
CREATE INDEX idx_team_players_user ON public.team_players USING btree (user_id);
CREATE INDEX idx_teams_captain_user ON public.teams USING btree (captain_user_id);
CREATE INDEX teams_community_id_idx ON public.teams USING btree (community_id);
CREATE INDEX teams_event_id_idx ON public.teams USING btree (event_id);
CREATE INDEX idx_tournaments_season ON public.tournaments USING btree (season_id);
CREATE INDEX tournaments_community_id_idx ON public.tournaments USING btree (community_id);
CREATE INDEX users_community_id_idx ON public.users USING btree (community_id);
CREATE INDEX volt_pulse_comm_idx ON public.volt_pulse USING btree (community_id, id DESC);

-- ── Functions ────────────────────────────────────────────────────────
-- Exactly as stored in the live database (pg_get_functiondef), A→Z.

CREATE OR REPLACE FUNCTION public.auth_community_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select community_id from users where id = auth.uid()
$function$
;

CREATE OR REPLACE FUNCTION public.auth_is_host()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from users where id = auth.uid() and role = 'host')
$function$
;

CREATE OR REPLACE FUNCTION public.auth_is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from users where id = auth.uid() and role in ('host','moderator'))
$function$
;

CREATE OR REPLACE FUNCTION public.create_community(p_name text, p_slug text, p_display_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare new_comm uuid;
begin
  if exists (select 1 from users where id = auth.uid()) then
    raise exception 'User already belongs to a community';
  end if;
  insert into communities (name, slug, subscription_status)
    values (p_name, p_slug, 'pending')
    returning id into new_comm;
  insert into users (id, community_id, role, display_name)
    values (auth.uid(), new_comm, 'host', p_display_name);
  return new_comm;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_league(p_name text, p_slug text, p_display text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_id uuid; v_status text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  -- An operator spinning up their own league shouldn't have to approve it.
  v_status := case when is_platform_admin() then 'approved' else 'pending' end;
  insert into communities (name, slug, status) values (p_name, p_slug, v_status)
    returning communities.id into v_id;
  insert into users (id, community_id, role, display_name)
    values (v_uid, v_id, 'host', coalesce(nullif(p_display,''), 'Host'))
    on conflict (id) do update set community_id = excluded.community_id,
      role = 'host', display_name = excluded.display_name;
  return json_build_object('id', v_id, 'name', p_name, 'slug', p_slug, 'status', v_status);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.events_fill_season()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_season uuid;
begin
  if new.season_id is null then
    select s.id into v_season from seasons s where s.community_id = new.community_id order by s.created_at desc limit 1;
    if v_season is null then
      insert into seasons (community_id, name) values (new.community_id, 'Season 1') returning seasons.id into v_season;
    end if;
    new.season_id := v_season;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_board_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if new.k like 'volt-auction-v2::%' and new.shared = true then
    if coalesce(current_setting('volt.skip_bcast', true), '') <> '1' then
      perform realtime.send(
        jsonb_build_object('t','sync','stamp', (new.val::jsonb->>'stamp')),
        'volt', 'volt:' || new.community_id::text, true);
    end if;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_guard_user_privileges()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- No JWT = server/cron context; leave it alone.
  if auth.uid() is null then return new; end if;

  -- Granting a staff role is the owner's call alone. Dropping to 'player' is
  -- always allowed, which is what happens when someone moves to another league.
  if new.role is distinct from old.role
     and new.role::text <> 'player'
     and not auth_is_host() then
    raise exception 'only the league host can grant staff roles';
  end if;

  -- Records and bans are league-managed. Staff write these (a moderator marking
  -- a no-show fires fn_no_show_penalty); players must never edit their own.
  if (new.suspension_remaining is distinct from old.suspension_remaining
      or new.trophy_streak    is distinct from old.trophy_streak
      or new.best_streak      is distinct from old.best_streak
      or new.weekends_won     is distinct from old.weekends_won
      or new.brackets_won     is distinct from old.brackets_won)
     and not auth_is_staff() then
    raise exception 'suspensions and season records are managed by the league';
  end if;

  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_move_player_data()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.community_id is distinct from old.community_id then
    update player_profiles set community_id = new.community_id where user_id = new.id;
    delete from player_contacts where user_id = new.id and community_id = old.community_id;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_no_show_penalty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE cnt int;
BEGIN
  IF NEW.no_show = true AND OLD.no_show IS DISTINCT FROM true THEN
    -- Counts only strikes inside the rolling window. NEW is already committed
    -- to the row at this point, so it is included by the query itself.
    SELECT count(*) INTO cnt FROM registrations
      WHERE user_id = NEW.user_id AND community_id = NEW.community_id
        AND no_show = true
        AND coalesce(no_show_at, created_at) > now() - interval '90 days';
    IF cnt >= 2 AND cnt % 2 = 0 THEN
      UPDATE users SET suspension_remaining = 2 WHERE id = NEW.user_id;
    END IF;
  ELSIF NEW.no_show = false AND OLD.no_show = true THEN
    UPDATE users SET suspension_remaining = 0
      WHERE id = NEW.user_id AND suspension_remaining > 0;
  END IF;
  RETURN NULL;   -- AFTER trigger: the return value is ignored anyway
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_no_show_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if NEW.no_show = true and OLD.no_show is distinct from true then
    NEW.no_show_at := now();
  elsif NEW.no_show = false and OLD.no_show = true then
    NEW.no_show_at := null;
  end if;
  return NEW;
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_protect_last_host()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_others int;
begin
  if old.role::text <> 'host' then return new; end if;
  -- Still a host of the same league? Nothing to check.
  if new.role::text = 'host' and new.community_id is not distinct from old.community_id then
    return new;
  end if;
  select count(*) into v_others
    from users where community_id = old.community_id and role::text = 'host' and id <> old.id;
  if v_others = 0 then
    raise exception 'This league would be left with no host. Make someone else a host first, then you can leave.';
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_serve_suspensions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.phase = 'settled' AND OLD.phase IS DISTINCT FROM 'settled' THEN
    UPDATE users u SET suspension_remaining = u.suspension_remaining - 1
    WHERE u.community_id = NEW.community_id AND u.suspension_remaining > 0
      AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = NEW.id AND r.user_id = u.id AND r.no_show = true);
  END IF;
  RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.is_platform_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$function$
;

CREATE OR REPLACE FUNCTION public.join_community(p_slug text, p_display_name text, p_wants_captain boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare target uuid;
begin
  if exists (select 1 from users where id = auth.uid()) then
    raise exception 'User already belongs to a community';
  end if;
  select id into target from communities where slug = p_slug;
  if target is null then
    raise exception 'No community with that code';
  end if;
  insert into users (id, community_id, role, display_name, wants_captain)
    values (auth.uid(), target, 'player', p_display_name, coalesce(p_wants_captain, false));
  return target;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.join_lookup(p_slug text)
 RETURNS TABLE(id uuid, name text, slug text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, c.name, c.slug from communities c
  where lower(c.slug) = lower(trim(p_slug))
    and c.status = 'approved'
  limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.kv_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at := now();
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.trg_block_unapproved_events()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status text;
begin
  select status into v_status from communities where id = NEW.community_id;
  if v_status is distinct from 'approved' then
    raise exception 'This league is % — it can''t run tournaments yet.', coalesce(v_status,'unknown');
  end if;
  return NEW;
end $function$
;

CREATE OR REPLACE FUNCTION public.trg_guard_community_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.status IS DISTINCT FROM OLD.status then
    -- auth.uid() is null for service-role and internal calls, which are trusted.
    if auth.uid() is not null and not is_platform_admin() then
      raise exception 'Only a platform operator can change a league''s status.';
    end if;
    NEW.reviewed_at := now();
  end if;
  return NEW;
end $function$
;

CREATE OR REPLACE FUNCTION public.trg_log_registration_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text;
begin
  select display_name into v_name from users where id = coalesce(NEW.user_id, OLD.user_id);
  v_name := coalesce(v_name, 'Someone');

  if TG_OP = 'INSERT' then
    insert into league_events (community_id, event_id, kind, subject_user_id, subject_name, detail)
    values (NEW.community_id, NEW.event_id,
            case when NEW.status = 'approved' then 'APPROVED' else 'APPLIED' end,
            NEW.user_id, v_name,
            case when NEW.wants_captain then 'put their hand up to captain' else null end);
    return NEW;
  end if;

  -- Only transitions are interesting. Re-saving the same row is not an event.
  if NEW.status is distinct from OLD.status then
    if NEW.status = 'approved' then
      insert into league_events (community_id, event_id, kind, subject_user_id, subject_name)
      values (NEW.community_id, NEW.event_id, 'APPROVED', NEW.user_id, v_name);
    elsif NEW.status = 'rejected' then
      insert into league_events (community_id, event_id, kind, subject_user_id, subject_name)
      values (NEW.community_id, NEW.event_id, 'REJECTED', NEW.user_id, v_name);
    end if;
  end if;

  if NEW.is_captain is distinct from OLD.is_captain then
    insert into league_events (community_id, event_id, kind, subject_user_id, subject_name)
    values (NEW.community_id, NEW.event_id,
            case when NEW.is_captain then 'CAPTAIN' else 'UNCAPTAIN' end, NEW.user_id, v_name);
  end if;

  -- Withdrawing before the draft is explicitly not a strike, so the ledger
  -- must not make it look like one.
  if NEW.declined_at is not null and OLD.declined_at is null then
    insert into league_events (community_id, event_id, kind, subject_user_id, subject_name, detail)
    values (NEW.community_id, NEW.event_id, 'WITHDREW', NEW.user_id, v_name, 'no strike — told us in time');
  end if;

  if NEW.no_show is distinct from OLD.no_show then
    insert into league_events (community_id, event_id, kind, subject_user_id, subject_name)
    values (NEW.community_id, NEW.event_id,
            case when NEW.no_show then 'NO_SHOW' else 'STRIKE_CLEARED' end, NEW.user_id, v_name);
  end if;

  return NEW;
end $function$
;

CREATE OR REPLACE FUNCTION public.trg_rearm_draft_messages()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if NEW.draft_at IS DISTINCT FROM OLD.draft_at then
    NEW.availability_check_at := null;
    NEW.draft_reminder_at := null;
  end if;
  return NEW;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_admin_leagues(p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_platform_admin() then raise exception 'not an operator'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'slug', c.slug, 'status', c.status,
      'createdAt', c.created_at, 'reviewedAt', c.reviewed_at,
      'note', c.requested_note,
      'host', (select u.display_name from users u
                where u.community_id = c.id and u.role::text = 'host' limit 1),
      'members', (select count(*) from users u where u.community_id = c.id),
      'events',  (select count(*) from events e where e.community_id = c.id),
      'discord', c.discord_guild_id is not null)
    order by (c.status = 'pending') desc, c.created_at desc)
    from communities c
    where p_status is null or c.status = p_status), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_admin_pending_count()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case when is_platform_admin()
    then (select count(*)::int from communities where status = 'pending')
    else 0 end;
$function$
;

CREATE OR REPLACE FUNCTION public.volt_admin_set_status(p_community uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_platform_admin() then raise exception 'not an operator'; end if;
  if p_status not in ('pending','approved','rejected','suspended') then
    raise exception 'unknown status %', p_status; end if;
  update communities set status = p_status, reviewed_at = now() where id = p_community;
  return jsonb_build_object('ok', true, 'status', p_status);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_apply(p_event uuid, p_wants_captain boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_comm uuid; v_phase text; v_role text; v_susp int;
  v_played int; v_strikes int; v_status text; v_name text; v_evlabel text;
  v_pool boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id, phase::text into v_comm, v_phase from events where id = p_event;
  if v_comm is null then raise exception 'no such weekend'; end if;
  select role::text, suspension_remaining into v_role, v_susp from users where id = v_uid and community_id = v_comm;
  if v_role is null then raise exception 'not a member of this league'; end if;

  -- Open = you're in the draft. Closed = you can still sign up, but as a reserve
  -- (the auction pool is locked). Past that the weekend is underway.
  if v_phase = 'registration_open' then v_pool := true;
  elsif v_phase = 'registration_closed' then v_pool := false;
  else raise exception 'registration is closed for this weekend';
  end if;

  if coalesce(v_susp,0) > 0 then raise exception 'suspended'; end if;
  if exists (select 1 from registrations where event_id = p_event and user_id = v_uid) then
    raise exception 'already applied';
  end if;
  select count(*) into v_played from registrations r join events e on e.id = r.event_id
    where r.user_id = v_uid and r.community_id = v_comm and r.status = 'approved' and e.phase = 'settled';
  select count(*) into v_strikes from registrations
    where user_id = v_uid and community_id = v_comm and no_show = true;
  v_status := case when v_role in ('host','moderator') then 'approved'
                   when v_played >= 2 and v_strikes = 0 then 'approved'
                   else 'pending' end;
  insert into registrations (event_id, community_id, user_id, status, availability_confirmed, wants_captain, pool_eligible)
  values (p_event, v_comm, v_uid, v_status, true, coalesce(p_wants_captain,false), v_pool);

  if v_status = 'pending' then
    select display_name into v_name from users where id = v_uid;
    select coalesce(weekend_label, 'the weekend') into v_evlabel from events where id = p_event;
    insert into notifications (community_id, user_id, event_id, kind, title, body)
    select v_comm, u.id, p_event, 'new_application',
           'New application to review',
           coalesce(v_name, 'A player') || ' applied for ' || v_evlabel
             || case when v_pool then '.' else ' as a reserve.' end
    from users u
    where u.community_id = v_comm and u.role in ('host','moderator');
  end if;

  return v_status;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_auctioneer(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_a uuid; v_uid uuid := auth.uid();
begin
  select community_id, auctioneer_id into v_comm, v_a from events where id = p_event;
  if v_comm is null then return jsonb_build_object('canRun', false); end if;
  return jsonb_build_object(
    'myId', v_uid,
    'auctioneer', v_a,
    'auctioneerName', (select display_name from users where id = v_a),
    -- Null auctioneer falls back to the host, so nothing breaks if it's unset.
    'canRun', case when v_a is not null then v_a = v_uid
                   else exists (select 1 from users where id = v_uid
                                 and community_id = v_comm and role::text = 'host') end,
    'isHost', exists (select 1 from users where id = v_uid
                       and community_id = v_comm and role::text = 'host'),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.display_name, 'role', u.role::text)
                                order by u.role::text, u.display_name)
                         from users u where u.community_id = v_comm
                          and u.role::text in ('host','moderator')), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_availability_mark_asked(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such event'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;

  -- Re-asking clears the old answers, otherwise last week's confirmations would
  -- make this week's silence look like everyone had replied.
  update registrations set reconfirmed_at = null
   where event_id = p_event and status = 'approved';
  update events set availability_check_at = now() where id = p_event;
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_availability_payload(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); e record; v_ts bigint; v_when text;
        v_users jsonb; v_reserves int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select ev.*, coalesce(ev.weekend_label,'this weekend') as label into e
    from events ev where ev.id = p_event;
  if e is null then raise exception 'no such tournament'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = e.community_id
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;
  if e.draft_at is null then return jsonb_build_object('error','nodraft'); end if;

  select coalesce(jsonb_agg(r.user_id), '[]'::jsonb) into v_users
    from registrations r
   where r.event_id = p_event and r.status = 'approved'
     and coalesce(r.pool_eligible, true) = true
     and r.declined_at is null;

  select count(*) into v_reserves
    from registrations r
   where r.event_id = p_event and r.status = 'approved'
     and coalesce(r.pool_eligible, true) = false;

  return jsonb_build_object(
    'communityId', e.community_id,
    'userIds', v_users,
    'skippedReserves', v_reserves,
    'alreadySent', e.availability_check_at is not null,
    'message', volt_availability_payload_internal(p_event)->>'message');
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_availability_payload_internal(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e record; v_ts bigint; v_when text;
begin
  select ev.*, coalesce(ev.weekend_label,'this weekend') as label into e
    from events ev where ev.id = p_event;
  if e is null or e.draft_at is null then return jsonb_build_object('message',''); end if;
  v_ts := extract(epoch from e.draft_at)::bigint;
  v_when := case
    when e.ends_on is not null and e.ends_on <> e.starts_on
      then to_char(e.starts_on,'FMDay') || ' and ' || to_char(e.ends_on,'FMDay')
    else to_char(e.starts_on,'FMDay') end;

  return jsonb_build_object('message',
    '**' || e.label || ' — are you free to play?**' ||
    E'\n\nMatches run **' || v_when || ', 7PM to 2AM**. Your team could be called at any point ' ||
    'in that window, so we need you around for all of it — not just a slot in it.' ||
    E'\n\nTap a button below.' ||
    E'\n\n**Before you say yes:** a captain will spend real budget on you, and once you are ' ||
    'drafted your team cannot replace you. If you say you can play and then do not turn up, ' ||
    'they play 4v5 and you pick up a **strike**. Two strikes within 90 days and you are ' ||
    '**suspended for the next two tournaments**.' ||
    E'\n\nSaying you might not make it costs you nothing at all — you go to the reserve list, ' ||
    'keep your clean record, and can still be subbed in if you free up. Only say yes if you ' ||
    'are confident.' ||
    E'\n\n-# The draft is <t:' || v_ts || ':F> and you do not have to be there — a captain bids ' ||
    'for you either way and I will DM you your team.');
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_availability_summary(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid; v_blocked uuid[];
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id, availability_blocked into v_comm, v_blocked
    from events where id = p_event;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;

  return jsonb_build_object(
    'asked', (select availability_check_at is not null from events where id = p_event),
    'confirmed', (select count(*) from registrations
                   where event_id = p_event and status='approved'
                     and coalesce(pool_eligible,true) and reconfirmed_at is not null),
    -- Who said yes, newest first: during a chase, the useful question is
    -- "who has come in since I last looked".
    'confirmedNames', coalesce((select jsonb_agg(u.display_name order by r.reconfirmed_at desc)
                 from registrations r join users u on u.id = r.user_id
                where r.event_id = p_event and r.status='approved'
                  and coalesce(r.pool_eligible,true)
                  and r.reconfirmed_at is not null), '[]'::jsonb),
    'silent', coalesce((select jsonb_agg(u.display_name order by u.display_name)
                 from registrations r join users u on u.id = r.user_id
                where r.event_id = p_event and r.status='approved'
                  and coalesce(r.pool_eligible,true)
                  and r.declined_at is null
                  and r.reconfirmed_at is null), '[]'::jsonb),
    -- Explicit withdrawals: a decision, not silence.
    'declined', coalesce((select jsonb_agg(u.display_name order by u.display_name)
                 from registrations r join users u on u.id = r.user_id
                where r.event_id = p_event and r.status='approved'
                  and r.declined_at is not null), '[]'::jsonb),
    'blocked', coalesce((select jsonb_agg(u.display_name order by u.display_name)
                 from users u where u.id = any(v_blocked)), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_bcast(p_comm uuid, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'realtime'
AS $function$
begin
  begin
    perform realtime.send(p_payload, 'volt', 'volt:' || p_comm::text, true);
  exception when others then
    null;  -- partitions missing; the table insert below is the live path
  end;
  insert into volt_pulse (community_id, payload) values (p_comm, p_payload);
  -- Keep it small. Only the newest few matter — anyone further behind than that
  -- refetches the board anyway.
  delete from volt_pulse
   where community_id = p_comm
     and id < (select max(id) - 40 from volt_pulse where community_id = p_comm);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_board_gap(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_val text; board jsonb; ids text[];
begin
  select community_id into v_comm from events where id = p_event;
  if v_comm is null or v_comm <> auth_community_id() then
    return jsonb_build_object('missing', '[]'::jsonb, 'onBoard', false); end if;

  select val into v_val from community_kv
   where community_id = v_comm and k = 'volt-auction-v2::' || p_event::text
     and shared = true and user_id is null;
  if v_val is null then return jsonb_build_object('missing', '[]'::jsonb, 'onBoard', false); end if;
  board := v_val::jsonb;

  select coalesce(array_agg(p->>'id'), '{}') into ids
    from jsonb_array_elements(board->'players') p;

  return jsonb_build_object(
    'onBoard', true,
    -- Draftable only: not a captain, not moved to reserves.
    'poolSize', (select count(*) from jsonb_array_elements(board->'players') p
                  where coalesce((p->>'isCaptain')::boolean,false) = false
                    and (p->>'poolEligible')::boolean is not false),
    'reserves', (select count(*) from jsonb_array_elements(board->'players') p
                  where coalesce((p->>'isCaptain')::boolean,false) = false
                    and (p->>'poolEligible')::boolean is false),
    'teams', jsonb_array_length(coalesce(board->'teams','[]'::jsonb)),
    'missing', coalesce((
      select jsonb_agg(jsonb_build_object('userId', u.id, 'name', u.display_name,
                                          'captain', r.is_captain)
             order by u.display_name)
        from registrations r join users u on u.id = r.user_id
       where r.event_id = p_event and r.status = 'approved'
         and coalesce(r.declined_at::text,'') = ''
         and coalesce(r.pool_eligible, true) = true
         and not (u.id::text = any(ids))), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_cron_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return jsonb_build_object('reminders', volt_run_reminders(), 'availability', volt_run_availability());
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_channel(p_guild text, p_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_id text;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('channel', null); end if;
  -- Prefer a tournament-scoped row, fall back to the league-wide one.
  select discord_id into v_id from discord_objects
   where community_id = v_comm and kind = 'text' and ref = p_ref
   order by (event_id is not null) desc, created_at desc limit 1;
  return jsonb_build_object('channel', v_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_confirm(p_guild text DEFAULT NULL::text, p_discord_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_ev record; v_pool boolean;
begin
  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then return jsonb_build_object('error','link'); end if;
  select e.id, coalesce(e.weekend_label,'this weekend') as label, e.draft_at into v_ev
    from events e where e.community_id = v.community_id and e.phase <> 'settled'
    order by e.starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  if not exists (select 1 from registrations where event_id = v_ev.id and user_id = v.user_id) then
    return jsonb_build_object('error','notin'); end if;

  update registrations
     set reconfirmed_at = now(), declined_at = null, availability_confirmed = true
   where event_id = v_ev.id and user_id = v.user_id
   returning coalesce(pool_eligible, true) into v_pool;

  return jsonb_build_object('ok', true, 'weekend', v_ev.label, 'inPool', v_pool,
    -- Null when unset, and the client omits the countdown rather than
    -- rendering an empty timestamp.
    'draftAt', case when v_ev.draft_at is null then null
                    else extract(epoch from v_ev.draft_at)::bigint end);
end $function$
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
    -- Semis sit between the groups and the final. Round 90/99 are sort keys
    -- only — they place the knockouts after every matchday without colliding
    -- with a real group round number.
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

CREATE OR REPLACE FUNCTION public.volt_dc_leaderboard(p_guild text, p_sort text DEFAULT 'acs'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_by_pts boolean := (p_sort = 'pts');
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  return coalesce((
    select jsonb_agg(x)
      from (
        select jsonb_build_object(
                 'name', u.display_name,
                 'avgAcs', round(avg((m.stat_payload->>'acs')::numeric)
                                 filter (where volt_did_play(m.stat_payload))),
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
           case when v_by_pts then round(avg((m.stat_payload->>'acs')::numeric)
                                         filter (where volt_did_play(m.stat_payload))) end desc nulls last,
           case when not v_by_pts then round(avg((m.stat_payload->>'acs')::numeric)
                                              filter (where volt_did_play(m.stat_payload))) end desc nulls last,
           case when not v_by_pts then round(coalesce(sum(m.points_computed),0)) end desc nulls last,
           count(*) filter (where volt_did_play(m.stat_payload)) desc
         limit 25) q), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_league(p_guild text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object('name', c.name, 'slug', c.slug)
    from communities c where c.discord_guild_id = p_guild limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_me(p_guild text, p_discord_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; p record; pts numeric; played int;
begin
  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then return jsonb_build_object('error','link'); end if;
  select rank, role, agent, kda, acs, hs, win into p
    from player_profiles where user_id = v.user_id and community_id = v.community_id;
  select coalesce(sum(points_computed),0), count(*) into pts, played
    from match_results where user_id = v.user_id and community_id = v.community_id;
  return jsonb_build_object('name', v.display_name,
    'rank', coalesce(p.rank,'—'), 'role', coalesce(p.role,'—'), 'agent', coalesce(p.agent,'—'),
    'kda', p.kda, 'acs', p.acs, 'hs', p.hs,
    'points', pts, 'matches', played,
    'streak', (select trophy_streak from users where id = v.user_id),
    'wins', (select weekends_won from users where id = v.user_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_pred_standings(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  return volt_pred_standings(v_comm);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_predict(p_guild text, p_discord_id text, p_match text, p_side text, p_guest_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_comm uuid; v_ev uuid; v_key text; v_val text; board jsonb; m jsonb;
        v_name text; v_voter text; v_votes jsonb; v_a text; v_b text; v_guest boolean := false;
begin
  if p_side not in ('a','b') then return jsonb_build_object('error','badside'); end if;

  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then
    -- No VOLT account: still allowed, as long as the server maps to a league.
    select id into v_comm from communities where discord_guild_id = p_guild;
    if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
    v_guest := true;
    v_voter := 'dc:' || p_discord_id;
    v_name  := coalesce(nullif(trim(p_guest_name), ''), 'Guest');
  else
    v_comm  := v.community_id;
    v_voter := v.user_id::text;
    select display_name into v_name from users where id = v.user_id;
    v_name := coalesce(v_name, 'Player');
  end if;

  select id into v_ev from events
   where community_id = v_comm and phase <> 'settled'
   order by starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('error','noevent'); end if;

  v_key := 'volt-auction-v2::' || v_ev::text;
  select val into v_val from community_kv
   where community_id = v_comm and k = v_key and shared and user_id is null for update;
  if v_val is null then return jsonb_build_object('error','noboard'); end if;
  board := v_val::jsonb;

  m := volt_json_find_match(board, p_match);
  if m is null then return jsonb_build_object('error','nomatch'); end if;
  if coalesce((m->>'done')::boolean,false) then return jsonb_build_object('error','done'); end if;
  if m->>'scheduledAt' is not null
     and (m->>'scheduledAt')::timestamptz <= now() then
    return jsonb_build_object('error','started');
  end if;

  v_votes := coalesce(m->'votes', '{}'::jsonb);
  v_votes := jsonb_set(v_votes, array[v_voter],
    jsonb_build_object('side', p_side, 'name', v_name, 'guest', v_guest));

  board := volt_json_set_match(board, p_match, 'votes', v_votes);
  perform set_config('volt.skip_bcast', '1', true);
  update community_kv set val = board::text
   where community_id = v_comm and k = v_key and shared and user_id is null;
  perform set_config('volt.skip_bcast', '0', true);

  select x->>'name' into v_a from jsonb_array_elements(board->'teams') x where x->>'id' = m->>'teamA';
  select x->>'name' into v_b from jsonb_array_elements(board->'teams') x where x->>'id' = m->>'teamB';
  perform volt_bcast(v_comm, jsonb_build_object('t','vote','event',v_ev));

  return jsonb_build_object('ok', true, 'guest', v_guest,
    'picked', case when p_side = 'a' then v_a else v_b end,
    'other',  case when p_side = 'a' then v_b else v_a end);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_register(p_guild text DEFAULT NULL::text, p_discord_id text DEFAULT NULL::text, p_captain boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_ev record; v_pool boolean; v_status text;
        v_played int; v_strikes int; v_susp int;
        v_league jsonb; v_missing text[] := '{}'; pp record; pc record;
begin
  v_league := volt_dc_league(p_guild);

  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then
    return jsonb_build_object('error','link', 'league', v_league);
  end if;

  select id, phase::text as phase, weekend_label into v_ev
    from events where community_id = v.community_id and phase in ('registration_open','registration_closed')
    order by starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('error','closed'); end if;

  select suspension_remaining into v_susp from users where id = v.user_id;
  if coalesce(v_susp,0) > 0 then return jsonb_build_object('error','suspended','n',v_susp); end if;
  if exists (select 1 from registrations where event_id = v_ev.id and user_id = v.user_id) then
    return jsonb_build_object('error','already'); end if;

  select rank, role into pp from player_profiles
   where user_id = v.user_id and community_id = v.community_id;
  select whatsapp into pc from player_contacts
   where user_id = v.user_id and community_id = v.community_id;
  if pp.rank is null then v_missing := v_missing || 'your rank'; end if;
  if pp.role is null then v_missing := v_missing || 'your role'; end if;
  if coalesce(pc.whatsapp,'') = '' then v_missing := v_missing || 'a WhatsApp number'; end if;
  if array_length(v_missing, 1) > 0 then
    return jsonb_build_object('error','profile', 'missing', v_missing, 'league', v_league);
  end if;

  v_pool := (v_ev.phase = 'registration_open');
  select count(*) into v_played from registrations r join events e on e.id = r.event_id
    where r.user_id = v.user_id and r.community_id = v.community_id and r.status='approved' and e.phase='settled';
  select count(*) into v_strikes from registrations
    where user_id = v.user_id and community_id = v.community_id and no_show = true;
  v_status := case when v.role in ('host','moderator') then 'approved'
                   when v_played >= 2 and v_strikes = 0 then 'approved' else 'pending' end;

  insert into registrations (event_id, community_id, user_id, status, availability_confirmed, wants_captain, pool_eligible)
  values (v_ev.id, v.community_id, v.user_id, v_status, true, coalesce(p_captain,false), v_pool);

  if v_status = 'pending' then
    insert into notifications (community_id, user_id, event_id, kind, title, body)
    select v.community_id, u.id, v_ev.id, 'new_application', 'New application to review',
           v.display_name || ' applied via Discord.'
      from users u where u.community_id = v.community_id and u.role in ('host','moderator');
  end if;
  return jsonb_build_object('ok', true, 'status', v_status, 'pool', v_pool,
                            'weekend', coalesce(v_ev.weekend_label,'this weekend'));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_role_for(p_guild text, p_discord_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_role text;
begin
  select id, discord_role_id into v_comm, v_role
    from communities where discord_guild_id = p_guild;
  if v_comm is null or v_role is null then return jsonb_build_object('roleId', null); end if;
  return jsonb_build_object('roleId', v_role);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_role_members(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev uuid; v_role text;
begin
  select id, discord_role_id into v_comm, v_role
    from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  select id into v_ev from events
   where community_id = v_comm and phase <> 'settled'
   order by starts_on nulls last limit 1;
  return jsonb_build_object(
    'roleId', v_role,
    'tag', volt_tournament_tag(v_comm),
    'members', coalesce((
      select jsonb_agg(pc.discord_user_id)
        from registrations r
        join player_contacts pc
          on pc.user_id = r.user_id and pc.community_id = r.community_id
       where r.event_id = v_ev and r.status = 'approved'
         and pc.discord_user_id is not null), '[]'::jsonb),
    -- id → display name, for reporting who couldn't be given the role.
    'names', coalesce((
      select jsonb_object_agg(pc.discord_user_id, u.display_name)
        from registrations r
        join users u on u.id = r.user_id
        join player_contacts pc
          on pc.user_id = r.user_id and pc.community_id = r.community_id
       where r.event_id = v_ev and r.status = 'approved'
         and pc.discord_user_id is not null), '{}'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_rollcall(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev uuid;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  select id into v_ev from events where community_id = v_comm and phase <> 'settled'
    order by starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  return jsonb_build_object('missing', coalesce((
    select jsonb_agg(jsonb_build_object('name', u.display_name, 'discord', pc.discord_user_id)
                     order by u.display_name)
      from registrations r
      join users u on u.id = r.user_id
      left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
     where r.event_id = v_ev and r.status = 'approved'
       and pc.discord_user_id is null), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_roster(p_guild text, p_discord_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_ev uuid; board jsonb; team jsonb; mates jsonb;
begin
  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then return jsonb_build_object('error','link'); end if;
  select id into v_ev from events where community_id = v.community_id and phase <> 'settled'
    order by starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  select val::jsonb into board from community_kv
   where community_id = v.community_id and k = 'volt-auction-v2::'||v_ev::text and shared = true;
  if board is null then return jsonb_build_object('error','noboard'); end if;

  -- The player is either a captain of a team or on its roster.
  select t into team from jsonb_array_elements(board->'teams') t
   where t->>'captainUserId' = v.user_id::text
      or coalesce(t->'roster','[]'::jsonb) ? v.user_id::text
   limit 1;
  if team is null then return jsonb_build_object('error','undrafted'); end if;

  select jsonb_agg(jsonb_build_object('name', p->>'name', 'rank', p->>'rank',
                                      'role', p->>'role', 'captain', false))
    into mates
    from jsonb_array_elements(board->'players') p
   where coalesce(team->'roster','[]'::jsonb) ? (p->>'id');

  return jsonb_build_object('team', team->>'name', 'captain', team->>'captain',
    'budget', team->>'budget', 'mates', coalesce(mates,'[]'::jsonb),
    'youAreCaptain', team->>'captainUserId' = v.user_id::text);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_scout(p_guild text, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; u record; p record; pts numeric; played int; v_reg text; v_did text;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;

  -- Exact display name, then exact IGN, then a loose match on either.
  select u2.id, u2.display_name, u2.trophy_streak, u2.weekends_won, u2.suspension_remaining into u
    from users u2 where u2.community_id = v_comm and u2.display_name ilike p_name limit 1;
  if u is null then
    select u2.id, u2.display_name, u2.trophy_streak, u2.weekends_won, u2.suspension_remaining into u
      from users u2 join player_profiles pp2 on pp2.user_id = u2.id and pp2.community_id = v_comm
     where u2.community_id = v_comm and pp2.ign ilike p_name limit 1;
  end if;
  if u is null then
    select u2.id, u2.display_name, u2.trophy_streak, u2.weekends_won, u2.suspension_remaining into u
      from users u2 left join player_profiles pp2 on pp2.user_id = u2.id and pp2.community_id = v_comm
     where u2.community_id = v_comm
       and (u2.display_name ilike '%'||p_name||'%' or pp2.ign ilike '%'||p_name||'%') limit 1;
  end if;
  if u is null then return jsonb_build_object('error','notfound'); end if;

  select pp.rank, pp.rank_div, pp.role, pp.agent, pp.kda, pp.acs, pp.hs, pp.win, pp.discord, pp.ign into p
    from player_profiles pp where pp.user_id = u.id and pp.community_id = v_comm;
  select pc.discord_user_id into v_did
    from player_contacts pc where pc.user_id = u.id and pc.community_id = v_comm;
  select coalesce(sum(points_computed),0), count(*) into pts, played
    from match_results where user_id = u.id and community_id = v_comm;

  select case when r.status is null then null
              when coalesce(r.pool_eligible,true) then 'in the draft'
              else 'reserve' end into v_reg
    from registrations r
    join events e on e.id = r.event_id and e.phase <> 'settled'
   where r.user_id = u.id and r.community_id = v_comm
   order by e.starts_on desc nulls last limit 1;

  return jsonb_build_object('name', u.display_name,
    'ign', p.ign,
    'discordId', v_did,
    'rank', coalesce(p.rank,'—') || case when p.rank_div is not null and p.rank <> 'Radiant'
                                         then ' ' || p.rank_div::text else '' end,
    'role', coalesce(p.role,'—'), 'agent', coalesce(p.agent,'—'),
    'kda', p.kda, 'acs', p.acs, 'hs', p.hs, 'discord', p.discord,
    'points', pts, 'matches', played,
    'streak', u.trophy_streak, 'wins', u.weekends_won,
    'suspended', coalesce(u.suspension_remaining,0),
    'signedUp', v_reg,
    'strikes', volt_strike_count(u.id, v_comm));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_search(p_guild text, p_query text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('name', display_name, 'value', display_name))
    from (select display_name from users
           where community_id = v_comm and display_name is not null
             and (coalesce(p_query,'') = '' or display_name ilike '%'||p_query||'%')
           order by display_name limit 25) q), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_subs(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev uuid;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','unlinked'); end if;
  select id into v_ev from events where community_id = v_comm and phase <> 'settled'
    order by starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'name', u.display_name, 'rank', coalesce(pp.rank,'—'),
      'discord', pc.discord_user_id))
    from registrations r
    join users u on u.id = r.user_id
    left join player_profiles pp on pp.user_id = u.id and pp.community_id = v_comm
    left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
    where r.event_id = v_ev and r.status = 'approved'
      and coalesce(r.pool_eligible, true) = false), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_tag(p_guild text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object('league', c.name, 'tag', volt_tournament_tag(c.id))
    from communities c where c.discord_guild_id = p_guild limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_teams(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_val text; board jsonb;
begin
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then return jsonb_build_object('error','noevent'); end if;
  select val into v_val from community_kv
   where community_id = v_comm and k = 'volt-auction-v2::' || p_event::text
     and shared = true and user_id is null;
  if v_val is null then return jsonb_build_object('error','noboard'); end if;
  board := v_val::jsonb;

  return jsonb_build_object(
    'tag', volt_tournament_tag(v_comm),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', t->>'name', 'hue', t->>'hue', 'captain', t->>'captain',
        'discordIds', coalesce((
          select jsonb_agg(pc.discord_user_id)
            from jsonb_array_elements(board->'players') p
            join player_contacts pc
              on pc.community_id = v_comm
             and pc.user_id::text = p->>'id'
           where p->>'soldTo' = t->>'id'
             and pc.discord_user_id is not null), '[]'::jsonb),
        'captainDiscord', (
          select pc.discord_user_id from player_contacts pc
           where pc.community_id = v_comm
             and pc.user_id::text = t->>'captainUserId' limit 1))
      order by t->>'name')
      from jsonb_array_elements(board->'teams') t), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_user(p_guild text, p_discord_id text)
 RETURNS TABLE(user_id uuid, community_id uuid, display_name text, role text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select u.id, u.community_id, u.display_name, u.role::text
  from player_contacts pc
  join users u on u.id = pc.user_id and u.community_id = pc.community_id
  left join communities c on c.id = pc.community_id
  where pc.discord_user_id = p_discord_id
    and (p_guild is null or c.discord_guild_id = p_guild)
  limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.volt_dc_withdraw(p_guild text DEFAULT NULL::text, p_discord_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_ev record; v_key text; v_val text; board jsonb;
        pi int; v_stamp bigint; v_name text;
begin
  select * into v from volt_dc_user(p_guild, p_discord_id);
  if v is null then return jsonb_build_object('error','link'); end if;
  select e.id, coalesce(e.weekend_label,'this weekend') as label, e.phase::text as phase, e.draft_at
    into v_ev
    from events e where e.community_id = v.community_id and e.phase <> 'settled'
    order by e.starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('error','noweekend'); end if;
  if not exists (select 1 from registrations where event_id = v_ev.id and user_id = v.user_id) then
    return jsonb_build_object('error','notin'); end if;
  -- Once the auction has started, pulling out is the host's call: the player may
  -- already have been bought.
  if v_ev.phase not in ('registration_open','registration_closed') then
    return jsonb_build_object('error','toolate');
  end if;

  update registrations
     set declined_at = now(), pool_eligible = false,
         reconfirmed_at = null, availability_confirmed = false
   where event_id = v_ev.id and user_id = v.user_id;

  -- Mirror onto the board so the auction agrees with the database.
  v_key := 'volt-auction-v2::' || v_ev.id::text;
  select val into v_val from community_kv
   where community_id = v.community_id and k = v_key and shared = true and user_id is null
   for update;
  if v_val is not null then
    board := v_val::jsonb;
    select idx - 1 into pi from jsonb_array_elements(board->'players') with ordinality e(pl, idx)
     where pl->>'id' = v.user_id::text limit 1;
    -- Only if they haven't already been sold; a sold player is the host's problem
    -- to unwind, not something a button should silently change.
    if pi is not null
       and coalesce(board->'players'->pi->>'status','pool') <> 'sold' then
      v_stamp := (extract(epoch from now())*1000)::bigint;
      board := jsonb_set(board, array['players', pi::text, 'poolEligible'], 'false'::jsonb);
      board := jsonb_set(board, '{stamp}', to_jsonb(v_stamp));
      select display_name into v_name from users where id = v.user_id;
      board := jsonb_set(board, '{log}',
        (jsonb_build_array(to_jsonb(coalesce(v_name,'A player') || ' moved to reserves'))
          || coalesce(board->'log','[]'::jsonb)));
      board := volt_trim_board(board);

      perform set_config('volt.skip_bcast', '1', true);
      update community_kv set val = board::text
       where community_id = v.community_id and k = v_key and shared = true and user_id is null;
      perform set_config('volt.skip_bcast', '0', true);

      -- Tell open draft rooms, so nobody nominates them a minute later.
      perform volt_bcast(v.community_id, jsonb_build_object(
        't','reserve', 'event', v_ev.id, 'stamp', v_stamp,
        'playerId', v.user_id::text, 'poolEligible', false));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'weekend', v_ev.label,
    'draftAt', case when v_ev.draft_at is null then null
                    else extract(epoch from v_ev.draft_at)::bigint end);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_did_play(p_stats jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce((p_stats->>'acs')::numeric, 0) > 0
      or coalesce((p_stats->>'k')::numeric, 0) > 0
      or coalesce((p_stats->>'a')::numeric, 0) > 0
      or coalesce((p_stats->>'d')::numeric, 0) > 0;
$function$
;

CREATE OR REPLACE FUNCTION public.volt_discord_link_code()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid; v_code text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from users where id = v_uid;
  if v_comm is null then raise exception 'not in a league'; end if;
  delete from discord_link_codes where user_id = v_uid and used_at is null;
  -- Ambiguity-free alphabet: no O/0, I/1, so it can be read aloud or retyped.
  v_code := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
              (floor(random()*32)+1)::int, 1), '') from generate_series(1,6));
  insert into discord_link_codes (code, user_id, community_id) values (v_code, v_uid, v_comm);
  return v_code;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_discord_link_oauth(p_user uuid, p_discord_id text, p_handle text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid;
begin
  select community_id into v_comm from users where id = p_user;
  if v_comm is null then return jsonb_build_object('ok', false, 'error', 'not in a league'); end if;

  update player_contacts set discord_user_id = null
   where community_id = v_comm and discord_user_id = p_discord_id and user_id <> p_user;

  insert into player_contacts (user_id, community_id, discord_user_id)
  values (p_user, v_comm, p_discord_id)
  on conflict (user_id, community_id) do update set discord_user_id = excluded.discord_user_id;

  if p_handle is not null then
    insert into player_profiles (user_id, community_id, discord, updated_at)
    values (p_user, v_comm, p_handle, now())
    on conflict (user_id) do update
      set discord = excluded.discord,
          community_id = excluded.community_id,
          updated_at = now();
  end if;

  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_discord_redeem(p_code text, p_discord_id text, p_handle text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  select * into r from discord_link_codes
   where code = upper(trim(p_code)) and used_at is null and expires_at > now();
  if r is null then return jsonb_build_object('ok', false, 'error', 'That code is invalid or has expired.'); end if;

  update player_contacts set discord_user_id = null
   where community_id = r.community_id and discord_user_id = p_discord_id and user_id <> r.user_id;

  insert into player_contacts (user_id, community_id, discord_user_id)
  values (r.user_id, r.community_id, p_discord_id)
  on conflict (user_id, community_id) do update set discord_user_id = excluded.discord_user_id;

  if p_handle is not null then
    insert into player_profiles (user_id, community_id, discord, updated_at)
    values (r.user_id, r.community_id, p_handle, now())
    on conflict (user_id) do update
      set discord = excluded.discord,
          community_id = excluded.community_id,
          updated_at = now();
  end if;

  update discord_link_codes set used_at = now() where code = r.code;
  return jsonb_build_object('ok', true,
    'name', (select display_name from users where id = r.user_id),
    'league', (select name from communities where id = r.community_id));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_discord_status(p_guild text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_ev record;
begin
  select id into v_comm from communities where discord_guild_id = p_guild;
  if v_comm is null then return jsonb_build_object('error','This server isn''t linked to a VOLT league yet.'); end if;
  select id, weekend_label, phase::text as phase into v_ev
    from events where community_id = v_comm and phase <> 'settled'
    order by starts_on desc nulls last limit 1;
  if v_ev is null then return jsonb_build_object('weekend', null); end if;
  return jsonb_build_object(
    'weekend', coalesce(v_ev.weekend_label, 'This weekend'),
    'phase',   v_ev.phase,
    'approved',(select count(*) from registrations where event_id = v_ev.id and status='approved'),
    'pending', (select count(*) from registrations where event_id = v_ev.id and status='pending'));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_draft_recap(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_val text; board jsonb; v_teams jsonb; v_sales jsonb;
begin
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then return jsonb_build_object('error','noevent'); end if;
  select val into v_val from community_kv
   where community_id = v_comm and k = 'volt-auction-v2::' || p_event::text
     and shared = true and user_id is null;
  if v_val is null then return jsonb_build_object('error','noboard'); end if;
  board := v_val::jsonb;

  -- Rosters with what each captain paid and what they left unspent.
  select jsonb_agg(jsonb_build_object(
           'name', t->>'name', 'hue', t->>'hue',
           'captain', t->>'captain',
           'left', (t->>'budget')::int,
           'spent', 10000 - (t->>'budget')::int,
           'roster', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'name', p->>'name', 'rank', p->>'rank', 'role', p->>'role',
                      'price', (p->>'soldPrice')::int, 'bids', (p->>'bidCount')::int)
                    order by (p->>'soldPrice')::int desc)
               from jsonb_array_elements(board->'players') p
              where p->>'soldTo' = t->>'id'), '[]'::jsonb))
         order by t->>'name')
    into v_teams
    from jsonb_array_elements(board->'teams') t;

  select jsonb_agg(jsonb_build_object(
           'name', p->>'name', 'price', (p->>'soldPrice')::int,
           'bids', coalesce((p->>'bidCount')::int, 0), 'rank', p->>'rank')
         order by (p->>'soldPrice')::int desc)
    into v_sales
    from jsonb_array_elements(board->'players') p
   where p->>'status' = 'sold';

  return jsonb_build_object(
    'tag', volt_tournament_tag(v_comm),
    'teams', coalesce(v_teams, '[]'::jsonb),
    'sales', coalesce(v_sales, '[]'::jsonb),
    'sold', coalesce(jsonb_array_length(v_sales), 0),
    'unsold', coalesce((select count(*) from jsonb_array_elements(board->'players') p
                         where p->>'status' <> 'sold' and coalesce((p->>'isCaptain')::boolean,false) = false), 0));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_get_discord()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); r record;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select c.discord_guild_id, c.discord_channel_id, c.discord_signup_channel_id,
         c.discord_role_id, c.discord_role_name into r
    from communities c join users u on u.community_id = c.id
   where u.id = v_uid and u.role::text in ('host','moderator');
  if r is null then
    return jsonb_build_object('guild', null, 'channel', null, 'signupChannel', null,
                              'roleId', null, 'roleName', null);
  end if;
  return jsonb_build_object('guild', r.discord_guild_id, 'channel', r.discord_channel_id,
                            'signupChannel', r.discord_signup_channel_id,
                            'roleId', r.discord_role_id, 'roleName', r.discord_role_name);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_ign_check(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_uid uuid := auth.uid();
begin
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such tournament'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'userId', u.id, 'name', u.display_name, 'ign', pp.ign,
             'discord', pc.discord_user_id)
           order by u.display_name)
      from registrations r
      join users u on u.id = r.user_id
      left join player_profiles pp on pp.user_id = u.id and pp.community_id = v_comm
      left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
     where r.event_id = p_event and r.status = 'approved'
       and coalesce(nullif(trim(pp.ign), ''), '') = ''), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_json_find_match(p_board jsonb, p_match text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
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
    if t->'final'->>'id' = p_match then return t->'final'; end if;
  elsif t->>'format' = 'single' then
    for m in select jsonb_array_elements(value) from jsonb_array_elements(t->'rounds') loop
      if m->>'id' = p_match then return m; end if;
    end loop;
  else
    for m in select * from jsonb_array_elements(coalesce(t->'matches','[]'::jsonb)) loop
      if m->>'id' = p_match then return m; end if;
    end loop;
  end if;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_json_set_match(p_board jsonb, p_match text, p_key text, p_val jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
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
  end if;
  return p_board;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_kv_cas(p_community uuid, p_key text, p_expected timestamp with time zone, p_val text)
 RETURNS TABLE(ok boolean, new_updated_at timestamp with time zone, cur_val text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_cur timestamptz;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from users u where u.id = v_uid and u.community_id = p_community) then
    raise exception 'not a member of this league';
  end if;

  -- Serialize concurrent writers on this exact row. Two captains bidding at
  -- the same instant queue here instead of racing.
  select ck.updated_at into v_cur from community_kv ck
   where ck.community_id = p_community and ck.k = p_key and ck.shared = true and ck.user_id is null
   for update;

  if p_expected is null then
    -- Unconditional write: first build, rebuild from registrations, reset.
    insert into community_kv (community_id, k, val, shared, user_id)
    values (p_community, p_key, p_val, true, null)
    on conflict (community_id, k, shared, user_id) do update set val = excluded.val;

  elsif v_cur is null then
    return query select false, null::timestamptz, null::text; return;

  elsif v_cur <> p_expected then
    -- Someone wrote first. Hand back what actually won so the caller can
    -- re-apply its change on top instead of clobbering it.
    return query select false, ck.updated_at, ck.val from community_kv ck
      where ck.community_id = p_community and ck.k = p_key and ck.shared = true and ck.user_id is null;
    return;

  else
    update community_kv set val = p_val
     where community_id = p_community and k = p_key and shared = true and user_id is null;
  end if;

  return query select true, ck.updated_at, ck.val from community_kv ck
    where ck.community_id = p_community and ck.k = p_key and ck.shared = true and ck.user_id is null;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_ledger(p_limit integer DEFAULT 20, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS SETOF league_events
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select * from league_events
   where community_id = auth_community_id()
     and (p_before is null or created_at < p_before)
   order by created_at desc
   limit least(coalesce(p_limit, 20), 100);
$function$
;

CREATE OR REPLACE FUNCTION public.volt_log_event(p_event uuid, p_kind text, p_subject uuid DEFAULT NULL::uuid, p_subject_name text DEFAULT NULL::text, p_team text DEFAULT NULL::text, p_amount integer DEFAULT NULL::integer, p_detail text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid; v_name text; v_actor text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such tournament'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;

  -- Whitelist: an open kind column would let a client invent entries that
  -- render as anything they like in the feed.
  if p_kind not in ('DRAFTED','UNDRAFTED','SUB_IN','TEAM_CREATED','WON','SETTLED','TRADE','NOTE') then
    raise exception 'unknown kind %', p_kind;
  end if;

  select display_name into v_name from users where id = p_subject;
  select display_name into v_actor from users where id = v_uid;

  insert into league_events (community_id, event_id, kind, subject_user_id,
                             subject_name, actor_name, team_name, amount, detail)
  values (v_comm, p_event, p_kind, p_subject,
          coalesce(v_name, p_subject_name), v_actor, p_team, p_amount, left(p_detail, 200));
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_notify_counts(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such event'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;

  return (
    select jsonb_build_object(
      'approved', jsonb_build_object(
        'total', count(*) filter (where approved),
        'unlinked', count(*) filter (where approved and not linked)),
      'unregistered', jsonb_build_object(
        'total', count(*) filter (where unreg),
        'unlinked', count(*) filter (where unreg and not linked)),
      'all', jsonb_build_object(
        'total', count(*) filter (where member),
        'unlinked', count(*) filter (where member and not linked)))
    from (
      select u.id,
             (pc.discord_user_id is not null) as linked,
             exists (select 1 from registrations r
                      where r.event_id = p_event and r.user_id = u.id
                        and r.status = 'approved') as approved,
             (coalesce(u.suspension_remaining,0) = 0
              and not exists (select 1 from registrations r2
                               where r2.event_id = p_event and r2.user_id = u.id)) as unreg,
             true as member
        from users u
        left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
       where u.community_id = v_comm
    ) x);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_notify_targets(p_event uuid, p_scope text DEFAULT 'approved'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such event'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only';
  end if;

  return (
    select jsonb_build_object(
      'communityId', v_comm,
      'scope',    p_scope,
      'userIds',  coalesce(jsonb_agg(t.user_id), '[]'::jsonb),
      'linked',   count(*) filter (where pc.discord_user_id is not null),
      'unlinked', count(*) filter (where pc.discord_user_id is null))
    from (
      select r.user_id
        from registrations r
       where p_scope in ('approved','registered')
         and r.event_id = p_event
         and (p_scope <> 'approved' or r.status = 'approved')
      union
      -- Suspended members are excluded from the sign-up nudge: inviting someone
      -- to register when the register call will reject them is just noise.
      select u.id
        from users u
       where p_scope in ('unregistered','all')
         and u.community_id = v_comm
         and (p_scope = 'all' or (
              coalesce(u.suspension_remaining, 0) = 0
              and not exists (select 1 from registrations r2
                               where r2.event_id = p_event and r2.user_id = u.id)))
    ) t
    left join player_contacts pc on pc.user_id = t.user_id and pc.community_id = v_comm);
end $function$
;

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
  v_pname text; v_tname text; v_ts timestamptz; v_stamp bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such weekend'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm) then
    raise exception 'not a member of this league'; end if;
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

CREATE OR REPLACE FUNCTION public.volt_pred_due(p_mins integer DEFAULT 60, p_mode text DEFAULT 'remind'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; out jsonb := '[]'::jsonb; board jsonb; t jsonb; ms jsonb; m jsonb; names jsonb;
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

    if t->>'format' = 'group' then
      select coalesce(jsonb_agg(q.m), '[]') into ms
        from (select jsonb_array_elements(value) m from jsonb_each(t->'matches')) q;
      if t->'final' is not null and t->'final' <> 'null'::jsonb then ms := ms || jsonb_build_array(t->'final'); end if;
    elsif t->>'format' = 'single' then
      select coalesce(jsonb_agg(q.m), '[]') into ms
        from (select jsonb_array_elements(value) m from jsonb_array_elements(t->'rounds')) q;
    else
      ms := coalesce(t->'matches', '[]'::jsonb);
    end if;

    for m in select * from jsonb_array_elements(ms) loop
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

CREATE OR REPLACE FUNCTION public.volt_pred_mark(p_event uuid, p_match text, p_field text DEFAULT 'predictedAt'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_key text; v_val text; board jsonb;
begin
  if p_field not in ('predictedAt','remindedAt') then raise exception 'bad field'; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_pred_open_all(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;
  return volt_pred_due(0, 'open');
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_pred_standings(p_community uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; r record; board jsonb; t jsonb; ms jsonb; m jsonb;
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

    if t->>'format' = 'group' then
      select coalesce(jsonb_agg(q.m), '[]') into ms
        from (select jsonb_array_elements(value) m from jsonb_each(t->'matches')) q;
      if t->'final' is not null and t->'final' <> 'null'::jsonb then ms := ms || jsonb_build_array(t->'final'); end if;
    elsif t->>'format' = 'single' then
      select coalesce(jsonb_agg(q.m), '[]') into ms
        from (select jsonb_array_elements(value) m from jsonb_array_elements(t->'rounds')) q;
    else
      ms := coalesce(t->'matches', '[]'::jsonb);
    end if;

    for m in select * from jsonb_array_elements(ms) loop
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

CREATE OR REPLACE FUNCTION public.volt_rank_bid(p_rank text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_rank
    when 'Iron' then 300 when 'Bronze' then 500 when 'Silver' then 800
    when 'Gold' then 1100 when 'Platinum' then 1500 when 'Diamond' then 2000
    when 'Ascendant' then 2600 when 'Immortal' then 3500 when 'Radiant' then 4500
    else 800 end;
$function$
;

CREATE OR REPLACE FUNCTION public.volt_rank_index(p_rank text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case p_rank
    when 'Iron' then 1 when 'Bronze' then 2 when 'Silver' then 3
    when 'Gold' then 4 when 'Platinum' then 5 when 'Diamond' then 6
    when 'Ascendant' then 7 when 'Immortal' then 8 when 'Radiant' then 9
    else 3 end;
$function$
;

CREATE OR REPLACE FUNCTION public.volt_run_availability()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e record; v_users uuid[]; n int := 0;
begin
  for e in
    select ev.id, ev.community_id
      from events ev join communities c on c.id = ev.community_id
     where ev.availability_check_at is null and ev.draft_at is not null
       and c.discord_guild_id is not null
       and ev.phase in ('registration_open','registration_closed')
       and ev.draft_at between now() + interval '22 hours' and now() + interval '26 hours'
  loop
    -- Pool only: reserves are already set aside, and a stale withdrawal
    -- shouldn't be asked again either.
    select array_agg(r.user_id) into v_users
      from registrations r
     where r.event_id = e.id and r.status = 'approved'
       and coalesce(r.pool_eligible, true) = true
       and r.declined_at is null;
    if v_users is not null and array_length(v_users,1) > 0 then
      perform volt_send_discord(e.community_id, v_users,
        volt_availability_payload_internal(e.id)->>'message', false, 'availability');
      n := n + 1;
    end if;
    update events set availability_check_at = now() where id = e.id;
  end loop;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_run_reminders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e record; v_users uuid[]; n int := 0; v_ts bigint;
begin
  for e in
    select ev.id, ev.community_id, ev.draft_at, coalesce(ev.weekend_label,'this weekend') as label
      from events ev join communities c on c.id = ev.community_id
     where ev.draft_reminder_at is null and ev.draft_at is not null
       and c.discord_guild_id is not null
       and ev.phase in ('registration_open','registration_closed','drafting')
       and ev.draft_at between now() + interval '20 minutes' and now() + interval '40 minutes'
  loop
    select array_agg(r.user_id) into v_users
      from registrations r where r.event_id = e.id and r.status = 'approved';
    if v_users is not null and array_length(v_users,1) > 0 then
      v_ts := extract(epoch from e.draft_at)::bigint;
      perform volt_send_discord(e.community_id, v_users,
        '**The draft for ' || e.label || ' starts <t:' || v_ts || ':R>** (<t:' || v_ts || ':t>).' ||
        E'\n\nBe in the voice channel. If you can''t make it, tell your host now — a no-show costs you a strike.',
        true);
      n := n + 1;
    end if;
    update events set draft_reminder_at = now() where id = e.id;
  end loop;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_sell(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid(); v_comm uuid; v_key text; v_val text; v_auct uuid;
  b jsonb; board jsonb; team jsonb; ti int; pi int; p jsonb;
  v_price int; v_leader text; v_ts timestamptz; v_bids int; v_stamp bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id, auctioneer_id into v_comm, v_auct from events where id = p_event;
  if v_comm is null then raise exception 'no such weekend'; end if;

  if v_auct is not null then
    if v_auct <> v_uid then raise exception 'someone else is running this auction'; end if;
  elsif not exists (select 1 from users where id = v_uid and community_id = v_comm and role::text = 'host') then
    raise exception 'only the host runs the auction';
  end if;

  v_key := 'volt-auction-v2::' || p_event::text;
  select val into v_val from community_kv
   where community_id = v_comm and k = v_key and shared = true and user_id is null for update;
  if v_val is null then raise exception 'no auction board yet'; end if;
  board := v_val::jsonb;

  b := board->'block';
  if b is null or b = 'null'::jsonb then raise exception 'Nobody is on the block.'; end if;
  v_leader := b->>'leaderId';
  if coalesce(v_leader,'') = '' then raise exception 'No bids yet — nothing to sell.'; end if;
  v_price := (b->>'currentBid')::int;
  v_bids := jsonb_array_length(coalesce(board->'bidHistory','[]'::jsonb));

  select idx - 1, t into ti, team from jsonb_array_elements(board->'teams') with ordinality e(t, idx)
   where t->>'id' = v_leader limit 1;
  select idx - 1, pl into pi, p from jsonb_array_elements(board->'players') with ordinality e(pl, idx)
   where pl->>'id' = b->>'playerId' limit 1;
  if team is null or p is null then raise exception 'That team or player is no longer on the board.'; end if;
  if p->>'status' = 'sold' then raise exception 'That player has already been sold.'; end if;
  if jsonb_array_length(coalesce(team->'roster','[]'::jsonb)) >= 4 then
    raise exception 'That team''s roster is already full.'; end if;
  if (team->>'budget')::int < v_price then
    raise exception 'That team no longer has enough budget for this bid.'; end if;

  v_stamp := (extract(epoch from now())*1000)::bigint;
  board := jsonb_set(board, array['teams', ti::text, 'budget'], to_jsonb((team->>'budget')::int - v_price));
  board := jsonb_set(board, array['teams', ti::text, 'roster'],
    coalesce(team->'roster','[]'::jsonb) || jsonb_build_array(p->>'id'));
  board := jsonb_set(board, array['players', pi::text, 'status'], '"sold"'::jsonb);
  board := jsonb_set(board, array['players', pi::text, 'soldTo'], to_jsonb(v_leader));
  board := jsonb_set(board, array['players', pi::text, 'soldPrice'], to_jsonb(v_price));
  board := jsonb_set(board, array['players', pi::text, 'bidCount'], to_jsonb(v_bids));
  board := jsonb_set(board, '{log}',
    (jsonb_build_array(to_jsonb('SOLD — '||(p->>'name')||' → '||(team->>'name')||' for $'||v_price::text))
      || coalesce(board->'log','[]'::jsonb)));
  board := jsonb_set(board, '{recentSales}',
    (jsonb_build_array(jsonb_build_object('playerId',p->>'id','name',p->>'name','teamId',v_leader,
      'price',v_price,'bidCount',v_bids,'ts',v_stamp)) || coalesce(board->'recentSales','[]'::jsonb)));
  board := jsonb_set(board, '{block}', 'null'::jsonb);
  board := jsonb_set(board, '{bidHistory}', '[]'::jsonb);
  board := jsonb_set(board, '{soldFlash}', to_jsonb(v_stamp));
  board := jsonb_set(board, '{lastSoldTo}', to_jsonb(v_leader));
  board := jsonb_set(board, '{stamp}', to_jsonb(v_stamp));
  board := volt_trim_board(board);

  perform set_config('volt.skip_bcast', '1', true);
  update community_kv set val = board::text
   where community_id = v_comm and k = v_key and shared = true and user_id is null
   returning updated_at into v_ts;
  perform set_config('volt.skip_bcast', '0', true);

  insert into league_events (community_id, event_id, kind, subject_user_id,
                             subject_name, team_name, amount, detail)
  values (v_comm, p_event, 'DRAFTED',
          case when (p->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then (p->>'id')::uuid else null end,
          p->>'name', team->>'name', v_price,
          case when v_bids > 1 then v_bids::text || ' bids' else null end);

  perform volt_bcast(v_comm, jsonb_build_object(
    't','sell', 'event', p_event, 'stamp', v_stamp, 'updatedAt', v_ts,
    'playerId', p->>'id', 'playerName', p->>'name',
    'teamId', v_leader, 'teamName', team->>'name',
    'price', v_price, 'bidCount', v_bids));

  return jsonb_build_object('board', board, 'updatedAt', v_ts);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_send_discord(p_comm uuid, p_users uuid[], p_msg text, p_announce boolean DEFAULT false, p_buttons text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_url text; v_secret text;
begin
  select v into v_url    from volt_config where k = 'notify_url';
  select v into v_secret from volt_config where k = 'notify_secret';
  if v_url is null or v_secret is null then
    raise notice 'volt_config missing notify_url/notify_secret — nothing sent';
    return null;
  end if;
  return net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-volt-secret', v_secret),
    body := jsonb_build_object(
      'communityId', p_comm, 'userIds', to_jsonb(p_users),
      'message', p_msg, 'announce', p_announce,
      'buttons', p_buttons, 'dmButtons', p_buttons is not null));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_set_auctioneer(p_event uuid, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid; v_name text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such tournament'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text = 'host') then
    raise exception 'only the host can hand over the gavel';
  end if;

  if p_user is not null then
    select display_name into v_name from users
     where id = p_user and community_id = v_comm and role::text in ('host','moderator');
    if v_name is null then raise exception 'that person is not staff in this league'; end if;
  end if;

  update events set auctioneer_id = p_user where id = p_event;
  return jsonb_build_object('ok', true, 'auctioneer', p_user, 'name', v_name);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_set_availability_blocked(p_event uuid, p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;
  update events set availability_blocked = p_ids where id = p_event;
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_set_discord(p_guild text, p_channel text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid; v_g text; v_c text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from users where id = v_uid and role::text = 'host';
  if v_comm is null then raise exception 'only the host can connect a Discord server'; end if;

  v_g := nullif(regexp_replace(coalesce(p_guild,''), '\D', '', 'g'), '');
  v_c := nullif(regexp_replace(coalesce(p_channel,''), '\D', '', 'g'), '');

  -- Discord IDs (snowflakes) are 17-20 digits. Catching this here means a typo
  -- gets a clear message instead of a bot that silently never responds.
  if v_g is not null and length(v_g) not between 17 and 20 then
    raise exception 'That server ID doesn''t look right — it should be 17-20 digits.'; end if;
  if v_c is not null and length(v_c) not between 17 and 20 then
    raise exception 'That channel ID doesn''t look right — it should be 17-20 digits.'; end if;
  if (v_g is null) <> (v_c is null) then
    raise exception 'Give both the server ID and the channel ID, or clear both.'; end if;

  if v_g is not null and exists (
      select 1 from communities where discord_guild_id = v_g and id <> v_comm) then
    raise exception 'That Discord server is already connected to another league.';
  end if;

  update communities set discord_guild_id = v_g, discord_channel_id = v_c where id = v_comm;
  return jsonb_build_object('ok', true, 'guild', v_g, 'channel', v_c);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_set_player_role(p_role text, p_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid; v_r text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from users
   where id = v_uid and role::text in ('host','moderator');
  if v_comm is null then raise exception 'staff only'; end if;
  v_r := nullif(regexp_replace(coalesce(p_role,''), '\D', '', 'g'), '');
  if v_r is not null and length(v_r) not between 17 and 20 then
    raise exception 'That role ID doesn''t look right.'; end if;
  update communities set discord_role_id = v_r,
         discord_role_name = coalesce(nullif(trim(p_name),''), discord_role_name)
   where id = v_comm;
  return jsonb_build_object('ok', true, 'roleId', v_r);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_set_request_note(p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid;
begin
  select community_id into v_comm from users
   where id = auth.uid() and role::text = 'host';
  if v_comm is null then raise exception 'hosts only'; end if;
  update communities set requested_note = left(coalesce(p_note,''), 500) where id = v_comm;
  return jsonb_build_object('ok', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_set_signup_channel(p_channel text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid; v_c text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from users
   where id = v_uid and role::text in ('host','moderator');
  if v_comm is null then raise exception 'staff only'; end if;
  v_c := nullif(regexp_replace(coalesce(p_channel,''), '\D', '', 'g'), '');
  if v_c is not null and length(v_c) not between 17 and 20 then
    raise exception 'That channel ID doesn''t look right.'; end if;
  update communities set discord_signup_channel_id = v_c where id = v_comm;
  return jsonb_build_object('ok', true, 'channel', v_c);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_settle_trophies(p_event uuid, p_team text, p_champions uuid[], p_recap jsonb DEFAULT NULL::jsonb, p_kind text DEFAULT 'weekend'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_comm uuid;
  v_undo jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such weekend'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm and role::text = 'host') then
    raise exception 'host only';
  end if;

  -- Snapshot BEFORE mutating. Without this the previous streaks are gone forever.
  select jsonb_agg(jsonb_build_object(
           'id', id, 'trophy_streak', trophy_streak, 'best_streak', best_streak,
           'weekends_won', weekends_won, 'brackets_won', brackets_won))
    into v_undo
    from users where community_id = v_comm;

  update users set trophy_streak = 0
    where community_id = v_comm and not (id = any(coalesce(p_champions, '{}'::uuid[])));
  update users set trophy_streak = trophy_streak + 1,
                   best_streak  = greatest(best_streak, trophy_streak + 1),
                   weekends_won = weekends_won + 1,
                   brackets_won = brackets_won + case when p_kind = 'bracket' then 1 else 0 end
    where community_id = v_comm and id = any(coalesce(p_champions, '{}'::uuid[]));

  update events set recap = coalesce(p_recap, '{}'::jsonb)
       || jsonb_build_object('team', p_team, 'ids', to_jsonb(coalesce(p_champions,'{}'::uuid[])),
                             'kind', p_kind, 'at', extract(epoch from now()),
                             '_undo', coalesce(v_undo, '[]'::jsonb))
    where id = p_event;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_strike_count(p_user uuid, p_community uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select count(*)::int from registrations
   where user_id = p_user and community_id = p_community
     and no_show = true
     and coalesce(no_show_at, created_at) > now() - interval '90 days';
$function$
;

CREATE OR REPLACE FUNCTION public.volt_sub_eligible(p_event uuid, p_out uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_rank text; v_idx int;
begin
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such tournament'; end if;
  select rank into v_rank from player_profiles where user_id = p_out and community_id = v_comm;
  v_idx := volt_rank_index(v_rank);

  return jsonb_build_object(
    'outRank', v_rank,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'userId', u.id, 'name', u.display_name,
               'rank', pp.rank, 'rankDiv', pp.rank_div, 'role', pp.role,
               'linked', pc.discord_user_id is not null)
             order by volt_rank_index(pp.rank) desc, u.display_name)
        from registrations r
        join users u on u.id = r.user_id
        left join player_profiles pp on pp.user_id = u.id and pp.community_id = v_comm
        left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
       where r.event_id = p_event
         and r.status = 'approved'
         and r.user_id <> p_out
         and coalesce(r.declined_at::text,'') = ''
         and volt_rank_index(pp.rank) < v_idx
         and coalesce((select suspension_remaining from users where id = u.id), 0) = 0
    ), '[]'::jsonb));
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_sub_fill(p_request uuid, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); r record; v_ok boolean; v_name text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into r from sub_requests where id = p_request for update;
  if r is null then raise exception 'no such request'; end if;
  if r.status <> 'open' then return jsonb_build_object('error','closed'); end if;

  select (r.captain_id = v_uid
       or exists (select 1 from users where id = v_uid and community_id = r.community_id
                    and role::text in ('host','moderator'))) into v_ok;
  if not v_ok then raise exception 'only the captain who asked, or staff, can fill this'; end if;

  if not exists (select 1 from sub_offers where request_id = p_request and user_id = p_user) then
    return jsonb_build_object('error','not_offered');
  end if;

  update sub_requests set status = 'filled', filled_user_id = p_user where id = p_request;
  select display_name into v_name from users where id = p_user;

  insert into league_events (community_id, event_id, kind, subject_user_id, subject_name,
                             team_name, detail)
  values (r.community_id, r.event_id, 'SUB_IN', p_user, v_name, r.team_name,
          'covering for ' || coalesce(r.out_name,'a player'));

  return jsonb_build_object('ok', true, 'name', v_name, 'team', r.team_name);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_sub_offer(p_request uuid, p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_ok boolean;
begin
  select * into r from sub_requests where id = p_request;
  if r is null then return jsonb_build_object('error','gone'); end if;
  if r.status <> 'open' then return jsonb_build_object('error','closed'); end if;

  select exists (
    select 1 from jsonb_array_elements(volt_sub_eligible(r.event_id, r.out_user_id)->'players') e
     where (e->>'userId')::uuid = p_user) into v_ok;
  if not v_ok then return jsonb_build_object('error','ineligible'); end if;

  insert into sub_offers (request_id, user_id) values (p_request, p_user)
  on conflict do nothing;
  return jsonb_build_object('ok', true, 'team', r.team_name, 'out', r.out_name);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_sub_open(p_event uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'team', r.team_name, 'outName', r.out_name, 'outRank', r.out_rank,
    'outUserId', r.out_user_id, 'captainId', r.captain_id, 'createdAt', r.created_at,
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'userId', u.id, 'name', u.display_name,
               'rank', pp.rank, 'rankDiv', pp.rank_div, 'role', pp.role,
               'at', o.created_at) order by o.created_at)
        from sub_offers o
        join users u on u.id = o.user_id
        left join player_profiles pp on pp.user_id = u.id and pp.community_id = r.community_id
       where o.request_id = r.id), '[]'::jsonb)
  ) order by r.created_at desc), '[]'::jsonb)
  from sub_requests r
  where r.event_id = p_event and r.status = 'open'
    and r.community_id = auth_community_id();
$function$
;

CREATE OR REPLACE FUNCTION public.volt_sub_request(p_event uuid, p_out uuid, p_team text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid; v_id uuid; v_rank text; v_name text; v_ok boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such tournament'; end if;

  select (exists (select 1 from registrations
                   where event_id = p_event and user_id = v_uid and is_captain)
       or exists (select 1 from users
                   where id = v_uid and community_id = v_comm and role::text in ('host','moderator')))
    into v_ok;
  if not v_ok then raise exception 'captains and staff only'; end if;

  if exists (select 1 from sub_requests
              where event_id = p_event and out_user_id = p_out and status = 'open') then
    return jsonb_build_object('error','already_open');
  end if;

  select display_name into v_name from users where id = p_out;
  select rank into v_rank from player_profiles where user_id = p_out and community_id = v_comm;

  insert into sub_requests (community_id, event_id, team_name, captain_id, out_user_id, out_name, out_rank)
  values (v_comm, p_event, coalesce(p_team,'the team'), v_uid, p_out, v_name, v_rank)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'outName', v_name, 'outRank', v_rank);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_sub_roster(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_comm uuid; v_val text; board jsonb;
begin
  select community_id into v_comm from events where id = p_event;
  if v_comm is null or v_comm <> auth_community_id() then
    return '[]'::jsonb; end if;
  select val into v_val from community_kv
   where community_id = v_comm and k = 'volt-auction-v2::' || p_event::text
     and shared = true and user_id is null;
  if v_val is null then return '[]'::jsonb; end if;
  board := v_val::jsonb;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'userId', p->>'id', 'name', p->>'name',
             'rank', p->>'rank', 'rankDiv', p->>'rankDiv',
             'team', (select t->>'name' from jsonb_array_elements(board->'teams') t
                       where t->>'id' = p->>'soldTo' limit 1))
           order by p->>'name')
      from jsonb_array_elements(board->'players') p
     where p->>'status' = 'sold'
       and (p->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       -- Already covered this weekend — don't offer to sub them twice.
       and not exists (select 1 from sub_requests sr
                        where sr.event_id = p_event
                          and sr.out_user_id = (p->>'id')::uuid
                          and sr.status in ('open','filled'))
  ), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_tournament_tag(p_community uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e record; a date; b date;
begin
  -- Prefer a live tournament; fall back to the most recent settled one so a
  -- message sent between tournaments still says which one it refers to.
  select weekend_label, starts_on, ends_on, phase::text into e
    from events where community_id = p_community and phase <> 'settled'
    order by starts_on nulls last limit 1;
  if e is null then
    select weekend_label, starts_on, ends_on, phase::text into e
      from events where community_id = p_community
      order by starts_on desc nulls last limit 1;
  end if;
  if e is null then return null; end if;
  if coalesce(e.weekend_label,'') <> '' then return e.weekend_label; end if;
  a := e.starts_on; b := coalesce(e.ends_on, e.starts_on);
  if a is null then return 'Tournament'; end if;
  if a = b then return to_char(a, 'Mon FMDD');
  elsif date_trunc('month', a) = date_trunc('month', b)
    then return to_char(a, 'Mon FMDD') || '-' || to_char(b, 'FMDD');
  else return to_char(a, 'Mon FMDD') || ' - ' || to_char(b, 'Mon FMDD');
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_transfer_ownership(p_to uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from users where id = v_uid and role::text = 'host';
  if v_comm is null then raise exception 'only the host can transfer ownership'; end if;
  if p_to = v_uid then raise exception 'pick someone other than yourself'; end if;
  if not exists (select 1 from users where id = p_to and community_id = v_comm) then
    raise exception 'that player is not in this league';
  end if;

  update users set role = 'host'      where id = p_to  and community_id = v_comm;
  -- The outgoing host stays on as a moderator rather than dropping to player:
  -- they keep helping, and they can step down further whenever they like.
  update users set role = 'moderator' where id = v_uid and community_id = v_comm;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_trim_board(board jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select jsonb_set(jsonb_set(jsonb_set(board,
    '{log}',        coalesce((select jsonb_agg(x) from (select x from jsonb_array_elements(board->'log') x limit 8) q), '[]'::jsonb)),
    '{bidHistory}', coalesce((select jsonb_agg(x) from (select x from jsonb_array_elements(board->'bidHistory') x limit 12) q), '[]'::jsonb)),
    '{recentSales}',coalesce((select jsonb_agg(x) from (select x from jsonb_array_elements(coalesce(board->'recentSales','[]'::jsonb)) x limit 10) q), '[]'::jsonb));
$function$
;

CREATE OR REPLACE FUNCTION public.volt_unlinked(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then raise exception 'staff only'; end if;
  return coalesce((select jsonb_agg(u.display_name order by u.display_name)
    from registrations r join users u on u.id = r.user_id
    left join player_contacts pc on pc.user_id = u.id and pc.community_id = v_comm
   where r.event_id = p_event and r.status = 'approved' and pc.discord_user_id is null), '[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_unsettle(p_event uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_comm uuid; v_undo jsonb; r jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id, recap->'_undo' into v_comm, v_undo from events where id = p_event;
  if v_comm is null then raise exception 'no such weekend'; end if;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm and role::text = 'host') then
    raise exception 'only the host can reopen a settled weekend';
  end if;
  if v_undo is null or jsonb_typeof(v_undo) <> 'array' then
    raise exception 'This weekend was settled before undo was supported, so its trophies can''t be restored automatically.';
  end if;

  for r in select * from jsonb_array_elements(v_undo) loop
    update users set
      trophy_streak = (r->>'trophy_streak')::int,
      best_streak   = (r->>'best_streak')::int,
      weekends_won  = (r->>'weekends_won')::int,
      brackets_won  = (r->>'brackets_won')::int
    where id = (r->>'id')::uuid and community_id = v_comm;
  end loop;

  update events set recap = null, phase = 'matches_live' where id = p_event;
end $function$
;

CREATE OR REPLACE FUNCTION public.volt_wants_captain(p_event uuid, p_v boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_phase text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select phase::text into v_phase from events where id = p_event;
  if v_phase is null then raise exception 'no such weekend'; end if;
  if v_phase not in ('registration_open','registration_closed') then raise exception 'captain volunteering is locked once the draft starts'; end if;
  update registrations set wants_captain = coalesce(p_v, false) where event_id = p_event and user_id = v_uid;
end
$function$
;

CREATE OR REPLACE FUNCTION public.volt_withdraw(p_event uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_phase text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select phase::text into v_phase from events where id = p_event;
  if v_phase is null then raise exception 'no such weekend'; end if;
  if v_phase not in ('registration_open','registration_closed') then
    raise exception 'the draft has started — talk to the Commissioner';
  end if;
  delete from registrations where event_id = p_event and user_id = v_uid;
end
$function$
;

-- ── Triggers ─────────────────────────────────────────────────────────
CREATE TRIGGER guard_community_status BEFORE UPDATE ON public.communities FOR EACH ROW EXECUTE FUNCTION trg_guard_community_status();
CREATE TRIGGER community_kv_broadcast AFTER INSERT OR UPDATE ON public.community_kv FOR EACH ROW EXECUTE FUNCTION fn_board_changed();
CREATE TRIGGER community_kv_touch BEFORE INSERT OR UPDATE ON public.community_kv FOR EACH ROW EXECUTE FUNCTION kv_touch_updated_at();
CREATE TRIGGER block_unapproved_events BEFORE INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION trg_block_unapproved_events();
CREATE TRIGGER rearm_draft_messages BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION trg_rearm_draft_messages();
CREATE TRIGGER trg_events_fill_season BEFORE INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION events_fill_season();
CREATE TRIGGER trg_serve_suspensions AFTER UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION fn_serve_suspensions();
CREATE TRIGGER player_contacts_touch BEFORE INSERT OR UPDATE ON public.player_contacts FOR EACH ROW EXECUTE FUNCTION kv_touch_updated_at();
CREATE TRIGGER log_registration_event AFTER INSERT OR UPDATE ON public.registrations FOR EACH ROW EXECUTE FUNCTION trg_log_registration_event();
CREATE TRIGGER no_show_stamp BEFORE UPDATE ON public.registrations FOR EACH ROW EXECUTE FUNCTION fn_no_show_stamp();
CREATE TRIGGER trg_no_show_penalty AFTER UPDATE ON public.registrations FOR EACH ROW EXECUTE FUNCTION fn_no_show_penalty();
CREATE TRIGGER users_guard_privileges BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION fn_guard_user_privileges();
CREATE TRIGGER users_move_player_data AFTER UPDATE OF community_id ON public.users FOR EACH ROW EXECUTE FUNCTION fn_move_player_data();
CREATE TRIGGER users_protect_last_host BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION fn_protect_last_host();

-- ── Row Level Security ───────────────────────────────────────────────
alter table public._volt_kv_backup_20260728 enable row level security;
alter table public.communities enable row level security;
alter table public.community_kv enable row level security;
alter table public.discord_link_codes enable row level security;
alter table public.discord_objects enable row level security;
alter table public.draft_state enable row level security;
alter table public.events enable row level security;
alter table public.league_events enable row level security;
alter table public.match_results enable row level security;
alter table public.notifications enable row level security;
alter table public.platform_admins enable row level security;
alter table public.player_contacts enable row level security;
alter table public.player_profiles enable row level security;
alter table public.registrations enable row level security;
alter table public.seasons enable row level security;
alter table public.sub_offers enable row level security;
alter table public.sub_requests enable row level security;
alter table public.team_players enable row level security;
alter table public.teams enable row level security;
alter table public.tournaments enable row level security;
alter table public.users enable row level security;
alter table public.volt_config enable row level security;
alter table public.volt_pulse enable row level security;

create policy comm_read on public.communities as PERMISSIVE for SELECT to public
  using ((id = auth_community_id()));

create policy ckv_read on public.community_kv as PERMISSIVE for SELECT to public
  using (((community_id = auth_community_id()) AND ((shared = true) OR (user_id = auth.uid()))));

create policy ckv_write on public.community_kv as PERMISSIVE for ALL to public
  using (((community_id = auth_community_id()) AND ((shared = true) OR (user_id = auth.uid()))))
  with check (((community_id = auth_community_id()) AND ((shared = true) OR (user_id = auth.uid()))));

create policy dlc_own on public.discord_link_codes as PERMISSIVE for ALL to public
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy discord_objects_read on public.discord_objects as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy ds_read on public.draft_state as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy ds_write on public.draft_state as PERMISSIVE for ALL to public
  using ((community_id = auth_community_id()))
  with check ((community_id = auth_community_id()));

create policy events_host_delete on public.events as PERMISSIVE for DELETE to public
  using (((community_id = auth_community_id()) AND auth_is_host()));

create policy events_read on public.events as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy events_staff_insert on public.events as PERMISSIVE for INSERT to public
  with check (((community_id = auth_community_id()) AND auth_is_staff()));

create policy events_staff_update on public.events as PERMISSIVE for UPDATE to public
  using (((community_id = auth_community_id()) AND auth_is_staff()))
  with check (((community_id = auth_community_id()) AND auth_is_staff() AND (auth_is_host() OR (phase <> 'settled'::event_phase))));

create policy league_events_read on public.league_events as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy mr_read on public.match_results as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy mr_staff_write on public.match_results as PERMISSIVE for ALL to public
  using (((community_id = auth_community_id()) AND auth_is_staff()))
  with check (((community_id = auth_community_id()) AND auth_is_staff()));

create policy notif_self_delete on public.notifications as PERMISSIVE for DELETE to public
  using ((user_id = auth.uid()));

create policy notif_self_read on public.notifications as PERMISSIVE for SELECT to public
  using ((user_id = auth.uid()));

create policy notif_self_update on public.notifications as PERMISSIVE for UPDATE to public
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy notif_staff_insert on public.notifications as PERMISSIVE for INSERT to public
  with check (((community_id = auth_community_id()) AND auth_is_staff()));

create policy platform_admins_self on public.platform_admins as PERMISSIVE for SELECT to public
  using ((user_id = auth.uid()));

create policy pc_delete on public.player_contacts as PERMISSIVE for DELETE to public
  using ((user_id = auth.uid()));

create policy pc_insert on public.player_contacts as PERMISSIVE for INSERT to public
  with check (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM users u
  WHERE ((u.id = auth.uid()) AND (u.community_id = player_contacts.community_id))))));

create policy pc_select on public.player_contacts as PERMISSIVE for SELECT to public
  using (((user_id = auth.uid()) OR (auth_is_staff() AND (community_id = auth_community_id()))));

create policy pc_update on public.player_contacts as PERMISSIVE for UPDATE to public
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));

create policy pp_read on public.player_profiles as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy pp_write_self on public.player_profiles as PERMISSIVE for ALL to public
  using (((user_id = auth.uid()) OR (auth_is_staff() AND (community_id = auth_community_id()))))
  with check (((user_id = auth.uid()) OR (auth_is_staff() AND (community_id = auth_community_id()))));

create policy regs_read on public.registrations as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy regs_self_delete on public.registrations as PERMISSIVE for DELETE to public
  using (((community_id = auth_community_id()) AND (user_id = auth.uid())));

create policy regs_self_insert on public.registrations as PERMISSIVE for INSERT to public
  with check (((community_id = auth_community_id()) AND (user_id = auth.uid()) AND (status = 'pending'::text) AND (( SELECT users.suspension_remaining
   FROM users
  WHERE (users.id = auth.uid())) = 0)));

-- regs_self_update existed here; dropped by migration 20261003093210_security_fixes.sql.

create policy regs_staff_write on public.registrations as PERMISSIVE for ALL to public
  using (((community_id = auth_community_id()) AND auth_is_staff()))
  with check (((community_id = auth_community_id()) AND auth_is_staff()));

create policy seasons_host_write on public.seasons as PERMISSIVE for ALL to public
  using (((community_id = auth_community_id()) AND auth_is_host()))
  with check (((community_id = auth_community_id()) AND auth_is_host()));

create policy seasons_read on public.seasons as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy sub_offers_read on public.sub_offers as PERMISSIVE for SELECT to public
  using ((EXISTS ( SELECT 1
   FROM sub_requests r
  WHERE ((r.id = sub_offers.request_id) AND (r.community_id = auth_community_id())))));

create policy sub_requests_read on public.sub_requests as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy tp_read on public.team_players as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

-- tp_staff_write is recreated with a league check by migration 20261003093210.
create policy tp_staff_write on public.team_players as PERMISSIVE for ALL to public
  using (auth_is_staff())
  with check (auth_is_staff());

create policy teams_read on public.teams as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy teams_staff_write on public.teams as PERMISSIVE for ALL to public
  using (((community_id = auth_community_id()) AND auth_is_staff()))
  with check (((community_id = auth_community_id()) AND auth_is_staff()));

create policy tourn_read on public.tournaments as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy tourn_staff_write on public.tournaments as PERMISSIVE for ALL to public
  using (((community_id = auth_community_id()) AND auth_is_staff()))
  with check (((community_id = auth_community_id()) AND auth_is_staff()));

create policy users_host_update on public.users as PERMISSIVE for UPDATE to public
  using (((community_id = auth_community_id()) AND auth_is_host()));

create policy users_read on public.users as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

create policy users_read_self on public.users as PERMISSIVE for SELECT to authenticated
  using ((id = auth.uid()));

create policy users_self_insert on public.users as PERMISSIVE for INSERT to authenticated
  with check ((id = auth.uid()));

create policy users_self_update on public.users as PERMISSIVE for UPDATE to public
  using ((id = auth.uid()));

create policy volt_pulse_read on public.volt_pulse as PERMISSIVE for SELECT to public
  using ((community_id = auth_community_id()));

-- ── Realtime ─────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.draft_state;
alter publication supabase_realtime add table public.volt_pulse;

-- ── Scheduled jobs (pg_cron) ─────────────────────────────────────────
-- Draft reminders + availability checks, every 5 minutes.
select cron.schedule('volt-tick', '*/5 * * * *', $$select public.volt_cron_tick();$$);
