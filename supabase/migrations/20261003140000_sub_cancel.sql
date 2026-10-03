-- A sub request could be opened and never closed: if nobody eligible had
-- Discord linked, or the DMs failed, it stayed 'open' forever, and asking
-- again for the same player hit 'already_open'. Let the captain who asked
-- (or staff) cancel it. Cancelled requests drop out of volt_sub_open and
-- free the player up again in volt_sub_roster (which only skips open/filled).

CREATE OR REPLACE FUNCTION public.volt_sub_cancel(p_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); r record;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into r from sub_requests where id = p_request for update;
  if r is null then return jsonb_build_object('error','gone'); end if;
  if r.status <> 'open' then return jsonb_build_object('error','closed'); end if;
  if not (r.captain_id = v_uid
          or exists (select 1 from users where id = v_uid and community_id = r.community_id
                       and role::text in ('host','moderator'))) then
    raise exception 'only the captain who asked, or staff, can cancel this';
  end if;
  update sub_requests set status = 'cancelled' where id = p_request;
  return jsonb_build_object('ok', true);
end $function$
;
revoke execute on function public.volt_sub_cancel(uuid) from public, anon;
grant execute on function public.volt_sub_cancel(uuid) to authenticated, service_role;
