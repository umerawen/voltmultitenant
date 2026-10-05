# VOLT League

Multi-tenant Valorant league platform: sign-ups, live auction draft, teams,
tournament bracket, predictions, leaderboard, plus a Discord bot.

## Layout
- `src/App.jsx` — the entire React frontend (~15k lines, one file). Talks to
  Supabase directly with the anon key; the draft board lives in `community_kv`
  behind the `window.storage` shim at the top of the file.
- `api/*.js` — Vercel serverless functions (Discord bot, notifications, Gemini
  screenshot readers). They use `SUPABASE_SERVICE_KEY`; browser callers must
  send their Supabase session as `Authorization: Bearer <jwt>` and are checked
  with `whoami()`.
- `schema.sql` — full snapshot of the live database (2026-10-03).
- `supabase/migrations/` — every database change after that snapshot, in order.

## Rules
- **Database changes go in a new `supabase/migrations/<timestamp>_<name>.sql`**
  and are then applied to the Supabase project (ref `fuelqjfyiqppxrdmmscu`).
  Never change the live DB without a matching file, or the repo drifts again.
- New `SECURITY DEFINER` functions are executable by anyone holding the public
  anon key unless you `revoke execute ... from public, anon, authenticated`.
  Functions meant only for `api/` (anything taking a guild/Discord id or a
  user id as a parameter) must be revoked and granted to `service_role`.
- Pushing to `main` deploys to production on Vercel immediately. The owner
  wants changes shipped straight to `main` (no preview branch, no PR to
  merge), so `npm run build` must pass before every push. If a deploy breaks
  the live site, roll back in Vercel (Instant Rollback) and then fix.
- Vercel is on the Hobby plan: crons can run at most once a day. Frequent jobs
  run from Supabase `pg_cron` (`volt_cron_tick`, every 5 minutes).

## Phone app (Capacitor)
- `android/` and `ios/` wrap the same web build (`capacitor.config.json`, app id
  `com.voltleagues.app`). `src/native.js` is the only native-aware code: inside
  the app `/api/*` goes to the live site (`apiUrl`), shared links use the site
  (`siteOrigin`), and sign-in / Discord linking open in the phone's browser and
  return via `com.voltleagues.app://auth` / `://discord` (the `appUrlOpen` listener).
  On the web every export is a no-op.
- `api/_cors.js` lets the app's origins (`capacitor://localhost`,
  `https://localhost`) call the API functions; new browser-called functions
  need `if (cors(req, res)) return;` first.
- Push: `push_tokens` + trigger `notifications_push` → `api/push.js` (FCM).
  Inert until `FIREBASE_SERVICE_ACCOUNT` (Vercel) and `VITE_PUSH=1` +
  `google-services.json` (app build) exist.
- The Android APK builds in GitHub Actions (`.github/workflows/android.yml`).
  After changing the web app: `npm run build && npx cap sync`. Icons/splash:
  `node reels/logo/app-assets.mjs`.

## Commands
- `npm install` then `npm run dev` — frontend at http://localhost:5173 (needs
  `.env.local`, see `.env.example`). `/api/*` is not served by Vite; use
  `vercel dev` or a preview deployment to exercise it.
- `npm run build` — production build.
