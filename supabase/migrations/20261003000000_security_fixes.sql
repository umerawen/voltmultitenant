-- ════════════════════════════════════════════════════════════════════
-- Security + correctness fixes found in the 2026-10-03 review.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Server-only functions were callable by anyone ─────────────────
-- Postgres lets every role EXECUTE a new function by default. These run with
-- owner rights (SECURITY DEFINER) and trust whatever guild / Discord id /
-- user id they're handed, because they're meant to be called by our Vercel
-- functions with the service key. But the anon key ships inside the public
-- JS bundle, so anyone could call them directly, e.g.:
--   volt_discord_link_oauth  → link ANY player's account to their own Discord
--   volt_send_discord        → make the bot DM any league's players anything
--   volt_dc_register/_withdraw/_confirm/_predict → act as any Discord user
--   volt_bcast               → inject fake live events into any draft room
-- The browser app never calls any of these (checked against src/App.jsx);
-- the api/ functions all use SUPABASE_SERVICE_KEY, which keeps access.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'volt\_dc\_%'
            or p.proname in (
              'volt_discord_link_oauth', 'volt_discord_redeem', 'volt_discord_status',
              'volt_send_discord', 'volt_bcast',
              'volt_cron_tick', 'volt_run_reminders', 'volt_run_availability',
              'volt_pred_due', 'volt_pred_mark',
              'volt_sub_offer', 'volt_draft_recap', 'volt_tournament_tag',
              'volt_availability_payload_internal', 'volt_strike_count',
              -- Legacy sign-up RPCs from the first schema. The app uses
              -- create_league / join_lookup now. create_community skipped the
              -- league approval gate (status defaults to 'approved'), and
              -- join_community let you join a pending/rejected league.
              'create_community', 'join_community'))
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ── 2. team_players: staff of ANY league could write ANY league's rows ──
drop policy if exists tp_staff_write on public.team_players;
create policy tp_staff_write on public.team_players as permissive for all to public
  using ((community_id = auth_community_id()) and auth_is_staff())
  with check ((community_id = auth_community_id()) and auth_is_staff());

-- ── 3. registrations: players could wipe their own strikes ───────────
-- regs_self_update let a player update their own row as long as the result
-- had status 'pending'. So one request — {status:'pending', no_show:false} —
-- erased a no-show strike (and could self-flag is_captain). Every legitimate
-- self-service change already goes through an RPC (volt_apply, volt_withdraw,
-- volt_wants_captain), and staff edits use regs_staff_write.
drop policy if exists regs_self_update on public.registrations;

-- ── 4. player_contacts: players could claim someone else's Discord id ──
-- The bot identifies people by discord_user_id. Only the server-side linking
-- flows (OAuth / link code, both SECURITY DEFINER) should ever set it; the app
-- itself only writes whatsapp.
revoke insert, update on public.player_contacts from anon, authenticated;
grant insert (user_id, community_id, whatsapp), update (user_id, community_id, whatsapp)
  on public.player_contacts to authenticated;

-- ── 5. volt_sub_eligible leaked other leagues' rosters ───────────────
-- Any signed-in user could pass another league's event id and get names and
-- ranks back. Signed-in callers are now limited to their own league; the
-- service role (Discord bot, via volt_sub_offer) has no auth.uid() and is
-- unaffected.
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
  if auth.uid() is not null and v_comm is distinct from auth_community_id() then
    raise exception 'no such tournament';
  end if;
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

-- ── 6. Existing players couldn't start their own league ──────────────
-- create_league moves the caller into the new league as host with an
-- upsert. For anyone already in a league as a player/moderator, the
-- users_guard_privileges trigger saw "player → host, and you're not a host"
-- and threw "only the league host can grant staff roles", so the whole
-- create failed. create_league now marks the transaction so the guard lets
-- that one upsert through. Clients can't set this flag themselves: it's a
-- transaction-local setting only reachable from inside this function.
CREATE OR REPLACE FUNCTION public.fn_guard_user_privileges()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- No JWT = server/cron context; leave it alone.
  if auth.uid() is null then return new; end if;

  -- create_league moving its own caller into the league they just made.
  if coalesce(current_setting('volt.creating_league', true), '') = '1'
     and new.id = auth.uid() then
    return new;
  end if;

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
  perform set_config('volt.creating_league', '1', true);
  insert into users (id, community_id, role, display_name)
    values (v_uid, v_id, 'host', coalesce(nullif(p_display,''), 'Host'))
    on conflict (id) do update set community_id = excluded.community_id,
      role = 'host', display_name = excluded.display_name;
  perform set_config('volt.creating_league', '0', true);
  return json_build_object('id', v_id, 'name', p_name, 'slug', p_slug, 'status', v_status);
end;
$function$
;

-- ── 7. Prediction "last call" reminders never ran ────────────────────
-- api/vercel.json scheduled /api/discord-predictions every 10 minutes, but
-- Vercel only reads vercel.json from the project root (and the Hobby plan
-- only allows daily crons anyway), so it never fired. The database already
-- ticks every 5 minutes, so it now calls the endpoint itself, and only when
-- a reminder is actually due.
CREATE OR REPLACE FUNCTION public.volt_run_predictions()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_url text; v_secret text;
begin
  if jsonb_array_length(volt_pred_due(60, 'remind')) = 0 then return null; end if;
  select v into v_url    from volt_config where k = 'notify_url';
  select v into v_secret from volt_config where k = 'notify_secret';
  if v_url is null or v_secret is null then return null; end if;
  return net.http_post(
    url := replace(v_url, '/api/discord-notify', '/api/discord-predictions'),
    headers := jsonb_build_object('Content-Type','application/json','x-volt-secret', v_secret),
    body := '{}'::jsonb);
end $function$
;
revoke execute on function public.volt_run_predictions() from public, anon, authenticated;
grant execute on function public.volt_run_predictions() to service_role;

CREATE OR REPLACE FUNCTION public.volt_cron_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return jsonb_build_object('reminders', volt_run_reminders(),
                            'availability', volt_run_availability(),
                            'predictions', volt_run_predictions());
end $function$
;
