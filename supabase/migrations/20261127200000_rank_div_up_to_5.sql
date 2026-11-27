-- Dota medals have 1–5 stars (Valorant divisions are 1–3). Widening the
-- checks lets the Dota build save stars 4 and 5; the Valorant site only ever
-- offers 1–3, so nothing changes there.
alter table public.player_profiles drop constraint if exists player_profiles_rank_div_ck;
alter table public.player_profiles add constraint player_profiles_rank_div_ck
  check (rank_div is null or (rank_div >= 1 and rank_div <= 5));
alter table public.player_profiles drop constraint if exists player_profiles_peak_rank_div_ck;
alter table public.player_profiles add constraint player_profiles_peak_rank_div_ck
  check (peak_rank_div is null or (peak_rank_div >= 1 and peak_rank_div <= 5));
