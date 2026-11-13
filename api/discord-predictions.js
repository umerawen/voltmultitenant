// api/discord-predictions.js — posts prediction cards before kick-off.
//
// Called on a schedule by the DB tick (volt_run_predictions, every 5 min).
// Idempotent: each match is stamped `predictedAt` / `remindedAt` on the board
// once posted, so repeated runs never double-post. Safe to call every few minutes.
//
// Pings: group-stage matches are never pinged by the timer. A knockout card
// the timer opens carries the role ping itself and gets no last call; a
// knockout card the host opened by hand (no ping) gets one last call an hour
// out. So a knockout match pings at most once, and the group stage not at all.
//
// The timer also does two posts per match night, neither of which pings:
//   * a match-day post six hours before the night's first kick-off: every game
//     that night, the pick split so far, and buttons to pick from right there;
//   * a player-of-the-night post once that night's stats are reported (or 12
//     hours after the last kick-off, with whatever was reported).
//
// Env: DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, VOLT_NOTIFY_SECRET
import { cors } from "./_cors.js";

const API = "https://discord.com/api/v10";
const WINDOW_MINS = 60;        // last call, for knockout cards the host opened by hand
const AUTO_OPEN_MINS = 180;    // post any unopened card this close to kick-off
const SAME_NIGHT_MINS = 180;   // and bring the rest of that night's cards with it
const MATCHDAY_MINS = 360;     // match-day post: this long before the night's first game
const NIGHT_MINS = 360;        // games within this long of the first are the same night
const POTN_WAIT_H = 12;        // post player of the night by then even if a match is unreported
const POTN_GIVE_UP_H = 48;     // a night older than this (or never reported) is skipped

export default async function handler(req, res) {
  if (cors(req, res)) return;   // the phone app calls from its own origin
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "DISCORD_BOT_TOKEN is not set" });

  const url = new URL(req.url, "http://x");
  // "open" posts the card and opens voting; "remind" nudges an hour out. The
  // cron only ever reminds — opening is the host's call, so a schedule that
  // isn't final yet doesn't get published by a timer.
  const mode = url.searchParams.get("mode") === "open" ? "open" : "remind";

  // The DB tick (volt_run_predictions) sends x-volt-secret; a Vercel cron would
  // send a CRON_SECRET bearer; a host-triggered call passes a user JWT, which
  // the RPC itself authorises. Anything else is refused, since this posts
  // publicly. With neither secret configured the endpoint stays open, as before.
  const secret = process.env.CRON_SECRET;
  const notifySecret = process.env.VOLT_NOTIFY_SECRET;
  const auth = req.headers.authorization || "";
  const qs = url.searchParams.get("secret");
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const bySecret = !!notifySecret && req.headers["x-volt-secret"] === notifySecret;
  const byCron = secret ? (auth === `Bearer ${secret}` || qs === secret) : !notifySecret;
  const cronOk = bySecret || byCron;
  if (mode === "open") {
    // Staff only, checked by Supabase against the caller's own token.
    if (!jwt) return res.status(401).json({ error: "unauthorized" });
  } else if (!cronOk) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    let due;
    if (mode === "open") {
      const eventId = req.body?.eventId || url.searchParams.get("eventId");
      if (!eventId) return res.status(400).json({ error: "eventId is required" });
      due = await rpcAs(jwt, "volt_pred_open_all", { p_event: eventId });
    } else {
      // The timer does two jobs. It opens any card still unposted 3 hours
      // before kick-off (opening was manual only, so a match whose teams were
      // settled late — the final, after the semis — never got one), and it
      // sends the last call an hour out for cards the host opened by hand.
      const [first, reminds] = await Promise.all([
        rpc("volt_pred_due", { p_mins: AUTO_OPEN_MINS, p_mode: "autoopen" }),
        rpc("volt_pred_due", { p_mins: WINDOW_MINS, p_mode: "remind" }),
      ]);
      let opens = first || [];
      if (opens.length) {
        // A match night is several games back to back. Post the whole night's
        // cards together, so the league is pinged once, not once per game.
        const night = await rpc("volt_pred_due", { p_mins: AUTO_OPEN_MINS + SAME_NIGHT_MINS, p_mode: "autoopen" });
        const events = new Set(opens.map((m) => m.eventId));
        const seen = new Set(opens.map((m) => m.matchId));
        opens = [...opens, ...(night || []).filter((m) => events.has(m.eventId) && !seen.has(m.matchId))]
          .sort((x, y) => x.at - y.at);
      }
      due = [...opens.map((m) => ({ ...m, kind: "open", auto: true })), ...(reminds || []).map((m) => ({ ...m, kind: "remind" }))];
    }
    if (!Array.isArray(due)) due = [];

    let posted = 0;
    const errors = [];
    const pinged = new Set();   // leagues already pinged in this run
    for (const m of due) {
      const kind = m.kind || mode;
      // Where to post. Falls back to the announcements channel if the league
      // hasn't built a #predictions channel yet — better a slightly noisy
      // announcement than a silently skipped match.
      const ch = (await rpc("volt_dc_channel", { p_guild: m.guild, p_ref: "predictions" }))?.channel
        || (await community(m.communityId))?.discord_channel_id;
      if (!ch) { errors.push(`${m.a} vs ${m.b}: no channel`); continue; }

      const body = kind === "open"
        ? [
            `## ${m.a}  vs  ${m.b}`,
            "",
            `Starts <t:${m.at}:F> — <t:${m.at}:R>${m.bo ? `  ·  Bo${m.bo}` : ""}`,
            "",
            "**Who takes it?** Tap below. You can change your mind right up to kick-off.",
            "-# Anyone in the server can predict — you don't need to be playing.",
          ].join("\n")
        : [
            `⏳ **Last call — ${m.a} vs ${m.b}**`,
            `Predictions close <t:${m.at}:R>, at kick-off.`,
          ].join("\n");

      const payload = {
        content: body,
        components: buttons(m.matchId, m.a, m.b),
        allowed_mentions: { parse: [] },
      };
      // The ping rides on the timer's own card, or on the last call for a card
      // the host opened by hand — and only on the first message of a run, so a
      // burst of cards is one notification. Never for a group-stage match (the
      // last call already skips them; this covers the card the timer opens).
      const ping = (kind === "remind" || (m.auto && m.stage !== "group")) && !pinged.has(m.communityId);
      let role = null;
      if (ping) {
        role = (await community(m.communityId))?.discord_role_id;
        if (role) {
          // On its own line: a heading only renders at the start of a line.
          payload.content = kind === "remind"
            ? `<@&${role}>  ${payload.content}`
            : `<@&${role}> predictions are open.\n${payload.content}`;
          payload.allowed_mentions = { parse: [], roles: [role] };
        }
      }
      const r = await call(token, `/channels/${ch}/messages`, "POST", payload);
      if (!r.ok) { errors.push(`${m.a} vs ${m.b}: ${r.reason}`); continue; }
      if (role) pinged.add(m.communityId);

      // Stamp only after a successful post, so a failure retries next tick.
      // A card the timer opened is marked reminded too: it has had its ping.
      await rpc("volt_pred_mark", { p_event: m.eventId, p_match: m.matchId,
        p_field: kind === "open" ? "predictedAt" : "remindedAt" });
      if (m.auto) await rpc("volt_pred_mark", { p_event: m.eventId, p_match: m.matchId, p_field: "remindedAt" });
      posted++;
    }
    // The night-level posts are the timer's alone. Each is wrapped so a failure
    // in one never stops the cards above or the other post.
    let days = 0, potn = 0;
    if (mode === "remind") {
      try { days = await matchDay(token, errors); } catch (e) { console.error("match day", e); errors.push(`match day: ${e.message}`); }
      try { potn = await playerOfNight(token, errors); } catch (e) { console.error("player of the night", e); errors.push(`player of the night: ${e.message}`); }
    }
    return res.status(200).json({ posted, days, potn, mode, errors });
  } catch (e) {
    console.error("predictions failed", e);
    return res.status(500).json({ error: e.message || "failed" });
  }
}

const byEvent = (rows) => {
  const out = new Map();
  for (const r of rows || []) { if (!out.has(r.eventId)) out.set(r.eventId, []); out.get(r.eventId).push(r); }
  for (const list of out.values()) list.sort((x, y) => x.at - y.at);
  return out;
};
// The first night in a sorted list: the first game and everything within
// NIGHT_MINS of it.
const firstNight = (list) => list.filter((m) => m.at <= list[0].at + NIGHT_MINS * 60);

async function channelFor(guild, communityId, ref) {
  return (await rpc("volt_dc_channel", { p_guild: guild, p_ref: ref }))?.channel
    || (await community(communityId))?.discord_channel_id || null;
}

/* ── Match day: tonight's games and how the picks stand ─────────────────── */

// "DEKU 63% ██████░░░░ 37% CLOWN TOWN", or a plain line before anyone picks.
function splitLine(m) {
  const a = Number(m.votesA) || 0, b = Number(m.votesB) || 0, n = a + b;
  if (!n) return "-# No picks yet";
  const pa = Math.round((a / n) * 100), k = Math.round(pa / 10);
  return `\`${"█".repeat(k)}${"░".repeat(10 - k)}\` **${pa}%** ${m.a} · **${100 - pa}%** ${m.b} (${n} pick${n === 1 ? "" : "s"})`;
}

export function matchDayMessage(night) {
  const n = night.length;
  const content = [
    `## 🎮 Match day — <t:${night[0].at}:D>`,
    `${n === 1 ? "One match" : `${n} matches`} tonight. Here's how the picks stand.`,
    "",
    ...night.flatMap((m) => [`**${m.a}  vs  ${m.b}** · <t:${m.at}:t> (<t:${m.at}:R>)${m.bo ? ` · Bo${m.bo}` : ""}`, splitLine(m), ""]),
    "-# Picks close at kick-off. Tap a team below to pick, or to change your pick.",
  ].join("\n");
  // One row of two buttons per match; Discord allows five rows.
  const components = night.slice(0, 5).flatMap((m) => buttons(m.matchId, m.a, m.b));
  return { content: content.slice(0, 2000), components, allowed_mentions: { parse: [] } };
}

async function matchDay(token, errors) {
  const first = await rpc("volt_pred_due", { p_mins: MATCHDAY_MINS, p_mode: "matchday" });
  if (!first?.length) return 0;
  const wide = byEvent(await rpc("volt_pred_due", { p_mins: MATCHDAY_MINS + NIGHT_MINS, p_mode: "matchday" }));
  let posted = 0;
  for (const [eventId, due] of byEvent(first)) {
    const night = firstNight(wide.get(eventId) || due);
    const ch = await channelFor(due[0].guild, due[0].communityId, "predictions");
    if (!ch) { errors.push("match day: no channel"); continue; }
    const r = await call(token, `/channels/${ch}/messages`, "POST", matchDayMessage(night));
    if (!r.ok) { errors.push(`match day: ${r.reason}`); continue; }
    for (const m of night) await rpc("volt_pred_mark", { p_event: eventId, p_match: m.matchId, p_field: "dayPostedAt" });
    posted++;
  }
  return posted;
}

/* ── Player of the night ─────────────────────────────────────────────────── */

// Match reports are filed under the fixture's label, "A vs B · 3F2K": the
// last four characters of the match id. That's the link back to the match.
const labelFor = (matchId) => String(matchId).slice(-4).toUpperCase();
const perfOf = (sp) => Number(sp?.ps ?? sp?.acs ?? 0) || 0;
const played = (sp) => perfOf(sp) > 0 || Number(sp?.k || 0) > 0 || Number(sp?.a || 0) > 0 || Number(sp?.d || 0) > 0;

// The cheapest-for-what-they-did player of the night: among everyone who played
// and was bought in the auction, whose performance placed furthest above where
// their price placed. Needs four priced players and a gap of two places.
export function bargainOfNight(ranked, prices) {
  const list = ranked.filter((r) => Number(prices?.[r.user_id]) > 0)
    .map((r) => ({ r, price: Number(prices[r.user_id]), perf: perfOf(r.stat_payload) }));
  if (list.length < 4) return null;
  const place = (key) => {
    const sorted = [...list].sort((x, y) => y[key] - x[key]); const out = new Map();
    for (let i = 0; i < sorted.length;) {
      let j = i; while (j + 1 < sorted.length && sorted[j + 1][key] === sorted[i][key]) j++;
      for (let k = i; k <= j; k++) out.set(sorted[k], (i + j) / 2 + 1);
      i = j + 1;
    }
    return out;
  };
  const byPrice = place("price"), byPerf = place("perf");
  const best = list.map((x) => ({ ...x, gap: byPrice.get(x) - byPerf.get(x) }))
    .sort((x, y) => y.gap - x.gap || x.price - y.price)[0];
  return best && best.gap >= 2 ? best : null;
}

export function playerOfNightMessage(night, rows, names, reported, prices = null) {
  // Each player's best game of the night, so one player can't fill the podium.
  const seen = new Set();
  const ranked = rows.filter((r) => played(r.stat_payload))
    .sort((x, y) => perfOf(y.stat_payload) - perfOf(x.stat_payload) || Number(y.stat_payload?.k || 0) - Number(x.stat_payload?.k || 0))
    .filter((r) => { const k = r.user_id || r.stat_payload?.name; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!ranked.length) return null;
  const who = (r) => names[r.user_id] || r.stat_payload?.name || "Player";
  const unit = () => "ACS";
  const top = ranked[0], sp = top.stat_payload || {};
  const next = ranked.slice(1, 3).map((r) => `**${who(r)}** ${perfOf(r.stat_payload)}`).join(" · ");
  const steal = bargainOfNight(ranked, prices);
  const of = reported < night.length ? `${reported} of ${night.length} reported matches` : `${night.length === 1 ? "the match" : `all ${night.length} matches`}`;
  return {
    content: [
      `## ⭐ Player of the night — <t:${night[0].at}:D>`,
      `**${who(top)}**${sp.team ? ` · ${sp.team}` : ""}`,
      `**${perfOf(sp)}** ${unit(sp)} · ${Number(sp.k || 0)} kills · ${Number(sp.a || 0)} assists`,
      `-# Best ACS across ${of}.${next ? ` Next best: ${next}` : ""}`,
      ...(steal ? [`💰 **Bargain of the night:** **${who(steal.r)}**, bought for $${steal.price.toLocaleString("en-US")}, put up ${steal.perf}.`] : []),
    ].join("\n"),
    allowed_mentions: { parse: [] },
  };
}

// What each drafted player went for, from the board. No board just means no bargain line.
async function soldPrices(eventId) {
  try {
    const [row] = await sb(`/rest/v1/community_kv?k=eq.${encodeURIComponent("volt-auction-v2::" + eventId)}&shared=eq.true&user_id=is.null&select=val`) || [];
    const board = typeof row?.val === "string" ? JSON.parse(row.val) : row?.val;
    const out = {};
    for (const p of board?.players || []) if (p?.status === "sold" && Number(p.soldPrice) > 0) out[p.id] = Number(p.soldPrice);
    return out;
  } catch (e) { console.error("sold prices", e); return null; }
}

async function playerOfNight(token, errors) {
  const kicked = await rpc("volt_pred_due", { p_mins: 0, p_mode: "potn" });
  if (!kicked?.length) return 0;
  const all = byEvent(await rpc("volt_pred_due", { p_mins: 0, p_mode: "potnall" }));
  const now = Date.now() / 1000;
  let posted = 0;
  for (const [eventId] of byEvent(kicked)) {
    const list = all.get(eventId) || [];
    if (!list.length) continue;
    const night = firstNight(list);
    const last = night[night.length - 1].at;
    if (last > now) continue;                                   // the night's still going
    const stamp = async () => { for (const m of night) await rpc("volt_pred_mark", { p_event: eventId, p_match: m.matchId, p_field: "potnAt" }); };
    if (last < now - POTN_GIVE_UP_H * 3600) { await stamp(); continue; }   // too old to celebrate

    // A forfeited match was never played, so it has no stats to wait for.
    const games = night.filter((m) => !m.forfeit);
    if (!games.length) { await stamp(); continue; }
    const ids = new Map(games.map((m) => [labelFor(m.matchId), m.matchId]));
    const rows = (await sb(`/rest/v1/match_results?event_id=eq.${eventId}&select=user_id,match_label,stat_payload`) || [])
      .filter((r) => ids.has(String(r.match_label || "").split(" · ").pop().toUpperCase()));
    const reported = new Set(rows.map((r) => String(r.match_label).split(" · ").pop().toUpperCase())).size;
    const waited = now > last + POTN_WAIT_H * 3600;
    if (reported < games.length && !waited) continue;           // stats still coming in
    if (!reported) continue;                                    // nothing yet; the give-up rule retires it

    const uids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const us = uids.length ? await sb(`/rest/v1/users?id=in.(${uids.join(",")})&select=id,display_name`) : [];
    const names = Object.fromEntries((us || []).map((u) => [u.id, u.display_name]));
    const msg = playerOfNightMessage(games, rows, names, reported, await soldPrices(eventId));
    if (!msg) { await stamp(); continue; }
    const ch = await channelFor(night[0].guild, night[0].communityId, "results");
    if (!ch) { errors.push("player of the night: no channel"); continue; }
    const r = await call(token, `/channels/${ch}/messages`, "POST", msg);
    if (!r.ok) { errors.push(`player of the night: ${r.reason}`); continue; }
    await stamp();
    posted++;
  }
  return posted;
}

// Labels are the team names themselves — clearer than "Team A"/"Team B" when
// the card is read on a phone hours later.
function buttons(matchId, a, b) {
  return [{ type: 1, components: [
    { type: 2, style: 1, label: String(a).slice(0, 60), custom_id: `volt_pred:${matchId}:a` },
    { type: 2, style: 1, label: String(b).slice(0, 60), custom_id: `volt_pred:${matchId}:b` },
  ] }];
}

async function community(id) {
  const r = await sb(`/rest/v1/communities?id=eq.${id}&select=discord_channel_id,discord_role_id`);
  return r?.[0] || null;
}

// Call an RPC as the signed-in host, so its own staff check applies.
async function rpcAs(jwt, fn, args) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
               Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error((await r.text()) || `supabase ${r.status}`);
  return r.json();
}

async function call(token, path, method, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 429) {
    const retry = Number(r.headers.get("retry-after") || 1);
    await new Promise((x) => setTimeout(x, retry * 1000 + 250));
    return call(token, path, method, body);
  }
  if (!r.ok) {
    let reason = `http ${r.status}`;
    try { const j = await r.json(); reason = j?.message || reason; } catch { /* keep status */ }
    return { ok: false, reason };
  }
  const text = await r.text();
  return { ok: true, body: text ? JSON.parse(text) : {} };
}

async function sb(path) {
  const r = await fetch(process.env.SUPABASE_URL + path, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
               Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return r.json();
}

async function rpc(fn, args) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
               Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
               "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
