-- Auction-night hardening.
--
-- 1. volt_kv_cas: a page that failed to read the board (network blip, Supabase
--    hiccup, or the user switched league in another tab so RLS hid the row)
--    used to "create" a fresh board with an unconditional write, replacing a
--    live auction. Now:
--      * the caller's active league must be the league being written;
--      * an unconditional write may only replace a board that is underway
--        (lot on the block, a sale, or a tournament) when the caller is staff;
--      * any unconditional overwrite of an underway board is copied to
--        volt_board_backups first.
-- 2. volt_place_bid / volt_sell: stamps are monotonic. Clients drop any board
--    whose stamp isn't newer than theirs, so a host whose clock ran ahead made
--    everyone ignore bids until real time caught up.

create table if not exists public.volt_board_backups (
  id          bigserial primary key,
  community_id uuid not null,
  k           text not null,
  val         text not null,
  saved_at    timestamptz not null default now(),
  saved_by    uuid
);
alter table public.volt_board_backups enable row level security;
revoke all on public.volt_board_backups from public, anon, authenticated;

create or replace function public.volt_kv_cas(p_community uuid, p_key text, p_expected timestamp with time zone, p_val text)
 returns table(ok boolean, new_updated_at timestamp with time zone, cur_val text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_cur timestamptz;
  v_old text;
  v_prog boolean := false;
  v_staff boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select role::text in ('host','moderator') into v_staff
    from users u where u.id = v_uid and u.community_id = p_community;
  if v_staff is null then
    raise exception 'not a member of this league';
  end if;
  if auth_community_id() is distinct from p_community then
    raise exception 'You switched to another league in a different tab or the app. Reload this page.';
  end if;

  -- Serialize concurrent writers on this exact row. Two captains bidding at
  -- the same instant queue here instead of racing.
  select ck.updated_at, ck.val into v_cur, v_old from community_kv ck
   where ck.community_id = p_community and ck.k = p_key and ck.shared = true and ck.user_id is null
   for update;

  if p_expected is null then
    -- Unconditional write: first build, rebuild from registrations, reset.
    if v_old is not null and p_key like 'volt-auction-v2%' then
      begin
        v_prog := coalesce(v_old::jsonb->'block', 'null'::jsonb) <> 'null'::jsonb
               or coalesce(v_old::jsonb->'tournament', 'null'::jsonb) <> 'null'::jsonb
               or exists (select 1 from jsonb_array_elements(coalesce(v_old::jsonb->'players', '[]'::jsonb)) p
                           where p->>'status' = 'sold');
      exception when others then v_prog := false;
      end;
      if v_prog then
        if not v_staff then
          raise exception 'The auction is already underway. Reload the page.';
        end if;
        insert into volt_board_backups (community_id, k, val, saved_by)
        values (p_community, p_key, v_old, v_uid);
      end if;
    end if;
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
end $function$;

create or replace function public.volt_place_bid(p_event uuid, p_team text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid(); v_comm uuid; v_key text; v_val text;
  b jsonb; board jsonb; team jsonb; ti int;
  v_req int; v_slots int; v_reserve int; v_max int;
  v_pname text; v_tname text; v_ts timestamptz; v_stamp bigint; v_staff boolean;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if v_comm is null then raise exception 'no such weekend'; end if;
  select role::text in ('host','moderator') into v_staff
    from users where id = v_uid and community_id = v_comm;
  if v_staff is null then raise exception 'not a member of this league'; end if;
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
  if coalesce(team->>'captainUserId','') <> '' and team->>'captainUserId' <> v_uid::text and not v_staff then
    raise exception 'You can only bid for your own team.';
  end if;
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
  -- Always newer than the board it replaces, whatever anyone's clock says.
  v_stamp := greatest((extract(epoch from now())*1000)::bigint,
                      coalesce((board->>'stamp')::bigint, 0) + 1);

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

  perform set_config('volt.skip_bcast', '1', true);
  update community_kv set val = board::text
   where community_id = v_comm and k = v_key and shared = true and user_id is null
   returning updated_at into v_ts;
  perform set_config('volt.skip_bcast', '0', true);

  perform volt_bcast(v_comm, jsonb_build_object(
    't','bid', 'event', p_event, 'stamp', v_stamp,
    'currentBid', v_req, 'leaderId', p_team, 'teamName', v_tname,
    'playerName', coalesce(v_pname,'the player'), 'updatedAt', v_ts));

  return jsonb_build_object('board', board, 'updatedAt', v_ts);
end $function$;

create or replace function public.volt_sell(p_event uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  v_stamp := greatest((extract(epoch from now())*1000)::bigint,
                      coalesce((board->>'stamp')::bigint, 0) + 1);
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
end $function$;

-- Same callers as before (signed-in members); nobody signed out needs these.
revoke execute on function public.volt_kv_cas(uuid, text, timestamptz, text) from public, anon;
revoke execute on function public.volt_place_bid(uuid, text) from public, anon;
revoke execute on function public.volt_sell(uuid) from public, anon;
grant execute on function public.volt_kv_cas(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.volt_place_bid(uuid, text) to authenticated;
grant execute on function public.volt_sell(uuid) to authenticated;
