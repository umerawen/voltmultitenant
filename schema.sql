-- ════════════════════════════════════════════════════════════════════
-- VOLT // DRAFT — SaaS schema + Row Level Security
-- Run this whole file in the Supabase SQL editor (one shot).
-- Multi-tenant: every row carries community_id; RLS enforces isolation.
-- ════════════════════════════════════════════════════════════════════

-- ── Enums ──────────────────────────────────────────────────────────
create type user_role        as enum ('host', 'player');
create type sub_status       as enum ('pending', 'trialing', 'active', 'past_due', 'canceled');
create type season_status    as enum ('upcoming', 'active', 'completed');
create type event_phase      as enum (
  'registration_open', 'registration_closed', 'drafting', 'matches_live', 'settled'
);

-- ════════════════════════════════════════════════════════════════════
-- TABLES
-- ════════════════════════════════════════════════════════════════════

-- Tenant root. One row per paying community.
create table communities (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text unique not null,
  subscription_status sub_status not null default 'pending',
  created_at          timestamptz not null default now()
);

-- Accounts. id mirrors auth.uid(). Sign up once; participate per weekend.
create table users (
  id            uuid primary key references auth.users(id) on delete cascade,
  community_id  uuid not null references communities(id) on delete cascade,
  role          user_role not null default 'player',
  display_name  text not null,
  wants_captain boolean not null default false,   -- standing raised hand
  created_at    timestamptz not null default now()
);
create index on users (community_id);

-- Month-long container. Holds 4 weekends + a closing tournament.
create table seasons (
  id            uuid primary key default gen_random_uuid(),
  community_id  uuid not null references communities(id) on delete cascade,
  name          text not null,
  status        season_status not null default 'upcoming',
  starts_at     date,
  ends_at       date,
  created_at    timestamptz not null default now()
);
create index on seasons (community_id);

-- The recurring weekend. Phase auto-advances by date; host can override.
create table events (
  id               uuid primary key default gen_random_uuid(),
  season_id        uuid not null references seasons(id) on delete cascade,
  community_id     uuid not null references communities(id) on delete cascade,
  weekend_label    text not null,                      -- e.g. "Week 2"
  phase            event_phase not null default 'registration_open',
  phase_overridden boolean not null default false,     -- host took manual control
  reg_opens        timestamptz,                        -- Mon
  reg_closes       timestamptz,                        -- Thu
  draft_at         timestamptz,                        -- Fri
  matches_start    timestamptz,                        -- Sat
  matches_end      timestamptz,                        -- Sun
  created_at       timestamptz not null default now()
);
create index on events (community_id);
create index on events (season_id);

-- Per-weekend opt-in. A player registers each weekend they're available.
-- is_captain is decided here, by the host, each Friday.
create table registrations (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references events(id) on delete cascade,
  community_id uuid not null references communities(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  is_captain   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (event_id, user_id)
);
create index on registrations (community_id);
create index on registrations (event_id);

-- Draft output: one team per captain, for one weekend.
create table teams (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references events(id) on delete cascade,
  community_id    uuid not null references communities(id) on delete cascade,
  captain_user_id uuid not null references users(id) on delete cascade,
  name            text,
  created_at      timestamptz not null default now()
);
create index on teams (community_id);
create index on teams (event_id);

-- Roster rows produced by the auction. draft_price = winning bid.
create table team_players (
  team_id      uuid not null references teams(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  community_id uuid not null references communities(id) on delete cascade,
  draft_price  integer not null default 0,
  primary key (team_id, user_id)
);
create index on team_players (community_id);

-- Per-player, per-weekend result. Combined scoring: stats + team win.
-- points_computed is materialized so the leaderboard is a cheap SUM.
create table match_results (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references events(id) on delete cascade,
  community_id    uuid not null references communities(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  team_id         uuid references teams(id) on delete set null,
  stat_payload    jsonb not null default '{}'::jsonb,  -- {kills, deaths, assists, ...}
  team_won        boolean not null default false,
  points_computed numeric not null default 0,
  created_at      timestamptz not null default now()
);
create index on match_results (community_id);
create index on match_results (event_id);
create index on match_results (user_id);

-- Season-end single-elim. size scales with active player count.
create table tournaments (
  id           uuid primary key default gen_random_uuid(),
  season_id    uuid not null references seasons(id) on delete cascade,
  community_id uuid not null references communities(id) on delete cascade,
  size         integer not null default 8,             -- top-N seeded
  bracket      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index on tournaments (community_id);

-- ════════════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS  (SECURITY DEFINER so policies can call them)
-- ════════════════════════════════════════════════════════════════════

-- The caller's community. Used by every policy. STABLE = cached per stmt.
create or replace function auth_community_id()
returns uuid language sql stable security definer set search_path = public as $$
  select community_id from users where id = auth.uid()
$$;

-- Is the caller the host of their community?
create or replace function auth_is_host()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from users where id = auth.uid() and role = 'host')
$$;

-- ════════════════════════════════════════════════════════════════════
-- ENABLE RLS  (deny-by-default once enabled; policies grant access)
-- ════════════════════════════════════════════════════════════════════
alter table communities   enable row level security;
alter table users         enable row level security;
alter table seasons       enable row level security;
alter table events        enable row level security;
alter table registrations enable row level security;
alter table teams         enable row level security;
alter table team_players  enable row level security;
alter table match_results enable row level security;
alter table tournaments   enable row level security;

-- ── communities ────────────────────────────────────────────────────
-- Read: only your own community. Write: handled by signup RPC (below).
create policy comm_read on communities for select
  using (id = auth_community_id());
create policy comm_host_update on communities for update
  using (id = auth_community_id() and auth_is_host());

-- ── users ──────────────────────────────────────────────────────────
-- Everyone in a community can see each other (roster, captain volunteers).
create policy users_read on users for select
  using (community_id = auth_community_id());
-- A player can edit their own row (display_name, wants_captain).
create policy users_self_update on users for update
  using (id = auth.uid());
-- Host can update anyone in their community (e.g. promote, correct).
create policy users_host_update on users for update
  using (community_id = auth_community_id() and auth_is_host());
-- Insert is done by the signup RPC (security definer), not direct.

-- ── seasons ────────────────────────────────────────────────────────
create policy seasons_read on seasons for select
  using (community_id = auth_community_id());
create policy seasons_host_write on seasons for all
  using (community_id = auth_community_id() and auth_is_host())
  with check (community_id = auth_community_id() and auth_is_host());

-- ── events ─────────────────────────────────────────────────────────
create policy events_read on events for select
  using (community_id = auth_community_id());
create policy events_host_write on events for all
  using (community_id = auth_community_id() and auth_is_host())
  with check (community_id = auth_community_id() and auth_is_host());

-- ── registrations ──────────────────────────────────────────────────
create policy regs_read on registrations for select
  using (community_id = auth_community_id());
-- A player can register / unregister THEMSELVES (but not set is_captain).
create policy regs_self_insert on registrations for insert
  with check (community_id = auth_community_id() and user_id = auth.uid()
              and is_captain = false);
create policy regs_self_delete on registrations for delete
  using (community_id = auth_community_id() and user_id = auth.uid());
-- Host manages everything (captain selection, removing players).
create policy regs_host_write on registrations for all
  using (community_id = auth_community_id() and auth_is_host())
  with check (community_id = auth_community_id() and auth_is_host());

-- ── teams ──────────────────────────────────────────────────────────
create policy teams_read on teams for select
  using (community_id = auth_community_id());
create policy teams_host_write on teams for all
  using (community_id = auth_community_id() and auth_is_host())
  with check (community_id = auth_community_id() and auth_is_host());

-- ── team_players (draft results) ───────────────────────────────────
create policy tp_read on team_players for select
  using (community_id = auth_community_id());
create policy tp_host_write on team_players for all
  using (community_id = auth_community_id() and auth_is_host())
  with check (community_id = auth_community_id() and auth_is_host());

-- ── match_results ──────────────────────────────────────────────────
create policy mr_read on match_results for select
  using (community_id = auth_community_id());
create policy mr_host_write on match_results for all
  using (community_id = auth_community_id() and auth_is_host())
  with check (community_id = auth_community_id() and auth_is_host());

-- ── tournaments ────────────────────────────────────────────────────
create policy tourn_read on tournaments for select
  using (community_id = auth_community_id());
create policy tourn_host_write on tournaments for all
  using (community_id = auth_community_id() and auth_is_host())
  with check (community_id = auth_community_id() and auth_is_host());

-- ════════════════════════════════════════════════════════════════════
-- SIGNUP RPCs
-- Direct insert into users/communities is blocked by RLS; these run as
-- SECURITY DEFINER so a brand-new authenticated user can bootstrap.
-- ════════════════════════════════════════════════════════════════════

-- Host self-serve: create a community + attach caller as its host.
-- Community starts 'pending' — you activate it (later: payment webhook).
create or replace function create_community(p_name text, p_slug text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
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
$$;

-- Player joins an existing community by slug.
create or replace function join_community(p_slug text, p_display_name text, p_wants_captain boolean)
returns uuid language plpgsql security definer set search_path = public as $$
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
$$;

-- Let authenticated users call the RPCs.
grant execute on function create_community(text, text, text) to authenticated;
grant execute on function join_community(text, text, boolean) to authenticated;
