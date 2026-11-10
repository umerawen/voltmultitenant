-- "Open predictions" opened every league's matches, not just the host's.
--
-- volt_pred_open_all(p_event) checked that the caller is staff of p_event's
-- league and then returned volt_pred_due(0, 'open') as is. volt_pred_due walks
-- every event in drafting / matches_live across all leagues, so the host of one
-- league pressing the button made api/discord-predictions.js post cards into
-- other leagues' Discord servers and stamp their matches as opened.
--
-- The result is now cut down to the event the caller was checked against.
-- volt_pred_due itself is unchanged: the timer (service role) still needs
-- every league, and its two-argument call sites keep working.
--
-- Grants: the function was still executable by PUBLIC and anon (it raised
-- 'not authenticated' for them, so nothing leaked). Tightened to match the
-- other host-called functions.

create or replace function public.volt_pred_open_all(p_event uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select community_id into v_comm from events where id = p_event;
  if not exists (select 1 from users where id = v_uid and community_id = v_comm
                   and role::text in ('host','moderator')) then
    raise exception 'staff only'; end if;
  return coalesce((
    select jsonb_agg(x.m order by x.ord)
      from jsonb_array_elements(volt_pred_due(0, 'open')) with ordinality as x(m, ord)
     where x.m->>'eventId' = p_event::text
  ), '[]'::jsonb);
end $function$;

revoke execute on function public.volt_pred_open_all(uuid) from public, anon;
grant execute on function public.volt_pred_open_all(uuid) to authenticated, service_role;
