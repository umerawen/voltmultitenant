-- Phone app push notifications.
--
-- The app (Capacitor) registers each device with Firebase and stores the token
-- here. Whenever the app creates in-app notifications (registration open, the
-- draft time, you're on the block, …), a statement-level trigger hands the new
-- rows that belong to people with the app to /api/push, which sends them through
-- Firebase Cloud Messaging. Nobody with the app installed → no call at all.

create table if not exists public.push_tokens (
  token        text primary key,
  user_id      uuid not null references public.users(id) on delete cascade,
  community_id uuid not null,
  platform     text not null check (platform in ('ios', 'android')),
  updated_at   timestamptz not null default now()
);
create index if not exists push_tokens_user on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

-- People read and remove their own devices. Registering goes through
-- volt_push_register(), which always files the token under the caller — so a
-- phone that changes hands moves to the new person, and nobody can file a token
-- under someone else.
create policy push_self_read   on public.push_tokens for select to authenticated using (user_id = auth.uid());
create policy push_self_delete on public.push_tokens for delete to authenticated using (user_id = auth.uid());

create or replace function public.volt_push_register(p_token text, p_platform text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare v_comm uuid;
begin
  if auth.uid() is null or coalesce(p_token, '') = '' or p_platform not in ('ios', 'android') then return; end if;
  select community_id into v_comm from users where id = auth.uid();
  if v_comm is null then return; end if;
  insert into push_tokens (token, user_id, community_id, platform, updated_at)
  values (p_token, auth.uid(), v_comm, p_platform, now())
  on conflict (token) do update set user_id = excluded.user_id, community_id = excluded.community_id,
    platform = excluded.platform, updated_at = now();
end $$;
revoke execute on function public.volt_push_register(text, text) from public, anon;
grant execute on function public.volt_push_register(text, text) to authenticated;

-- Hand new notifications to /api/push. Same notify_url / notify_secret the
-- Discord sender uses (volt_config); the URL is derived from it.
create or replace function public.volt_push_new_notifications()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $$
declare v_url text; v_secret text; v_ids jsonb;
begin
  select jsonb_agg(n.id) into v_ids
    from ins n
   where exists (select 1 from push_tokens t where t.user_id = n.user_id);
  if v_ids is null then return null; end if;
  select v into v_url    from volt_config where k = 'notify_url';
  select v into v_secret from volt_config where k = 'notify_secret';
  if v_url is null or v_secret is null then return null; end if;
  perform net.http_post(
    url := replace(v_url, '/api/discord-notify', '/api/push'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-volt-secret', v_secret),
    body := jsonb_build_object('ids', v_ids));
  return null;
-- A push is a bonus; it must never stop the notification itself being saved.
exception when others then
  raise warning 'volt push: %', sqlerrm;
  return null;
end $$;
revoke execute on function public.volt_push_new_notifications() from public, anon, authenticated;

drop trigger if exists notifications_push on public.notifications;
create trigger notifications_push
  after insert on public.notifications
  referencing new table as ins
  for each statement execute function public.volt_push_new_notifications();
