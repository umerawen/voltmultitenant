-- One-off data fix (already applied): a member was on a draft board without a
-- sign-up for that tournament, so opening the draft (which rebuilds the board
-- from sign-ups) would have dropped them. Adds the missing approved sign-up.
insert into registrations (event_id, community_id, user_id, status, is_captain, wants_captain, pool_eligible, availability_confirmed, no_show)
select '7b23480d-be78-42ef-b31e-18da0baa3fb4', 'd6c90231-d9c2-48f5-a61a-e6f64270a653', '51c780cf-8e10-461c-b5e0-c135a8bd8f90', 'approved', false, false, true, true, false
where not exists (select 1 from registrations
                  where event_id = '7b23480d-be78-42ef-b31e-18da0baa3fb4'
                    and user_id  = '51c780cf-8e10-461c-b5e0-c135a8bd8f90');
