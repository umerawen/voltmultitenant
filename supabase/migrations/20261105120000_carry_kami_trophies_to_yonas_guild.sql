-- One-off, requested by the owner: players who won a title in Kami Labs and are
-- also members of Yona's Guild get that record shown in Yona's Guild too.
-- Data only. Kami Labs is not changed and no league copies trophies automatically.
--
-- Safe to run twice: only rows with no titles in Yona's Guild are updated.
-- To reverse, set these four columns back to 0 for the same players, as long as
-- Yona's Guild has not settled a tournament since.

do $$
declare
  v_from uuid;
  v_to   uuid;
begin
  select id into strict v_from from public.communities where name = 'Kami Labs';
  select id into strict v_to   from public.communities where name = 'Yona''s Guild';

  update public.users y
     set trophy_streak = k.trophy_streak,
         best_streak   = k.best_streak,
         weekends_won  = k.weekends_won,
         brackets_won  = k.brackets_won
    from public.users k
   where k.community_id = v_from
     and k.weekends_won > 0
     and y.id = k.id
     and y.community_id = v_to
     and y.weekends_won = 0;
end $$;
