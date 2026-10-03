-- "Continue with Discord": someone who signs in through Supabase's Discord
-- provider has already proved who they are on Discord, so there's no reason to
-- send them through the separate Connect Discord step. This links the Discord
-- identity on their auth account to their league profile (player_contacts +
-- the handle on player_profiles), reusing volt_discord_link_oauth.
--
-- Safe to expose to signed-in users: it only ever reads the caller's own
-- verified identity (auth.uid()), never a Discord id passed in.

CREATE OR REPLACE FUNCTION public.volt_link_discord_from_auth()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_did text; v_handle text; v_comm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select i.provider_id,
         regexp_replace(coalesce(i.identity_data->>'name', i.identity_data->>'user_name', i.identity_data->>'full_name'), '#0$', '')
    into v_did, v_handle
    from auth.identities i
   where i.user_id = v_uid and i.provider = 'discord'
   order by i.created_at desc limit 1;
  if v_did is null then return jsonb_build_object('linked', false, 'reason', 'no_discord_identity'); end if;
  select community_id into v_comm from users where id = v_uid;
  if v_comm is null then return jsonb_build_object('linked', false, 'reason', 'no_league'); end if;
  return volt_discord_link_oauth(v_uid, v_did, v_handle) || jsonb_build_object('linked', true, 'handle', v_handle);
end $function$
;
revoke execute on function public.volt_link_discord_from_auth() from public, anon;
grant execute on function public.volt_link_discord_from_auth() to authenticated, service_role;
