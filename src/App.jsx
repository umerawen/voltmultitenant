// ════════════════════════════════════════════════════════════════════
// VOLT // LEAGUE — single self-contained app.
// Renders on MOCK data when no Supabase env is present (e.g. local preview
// or an inline artifact), and talks to REAL Supabase when the env vars
// exist (e.g. on Vercel). Screens call DB.* and don't know the difference.
// ════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

/* ══════════════ THEME (was theme.jsx) ══════════════ */
const HUE="#3d7bff", CYAN="#00e5ff", TEXT="#ecf3ff", MUTE="rgba(200,215,255,0.55)";
const FONT_BODY="'Space Grotesk',sans-serif", FONT_HEAD="'Tungsten','Rajdhani',sans-serif",
      FONT_LABEL="'Rajdhani',sans-serif", FONT_MONO="'IBM Plex Mono',monospace";
const notch=(n=16)=>`polygon(0 0, calc(100% - ${n}px) 0, 100% ${n}px, 100% 100%, ${n}px 100%, 0 calc(100% - ${n}px))`;

function Fonts(){
  return <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@500;700&display=swap');
    .view-in{animation:viewin .4s ease;} @keyframes viewin{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
    @keyframes voltpop{from{opacity:0;transform:scale(0.85);}to{opacity:1;transform:scale(1);}}
    .grid-bg{background-image:linear-gradient(rgba(157,107,255,0.06) 1px,transparent 1px),linear-gradient(90deg,rgba(157,107,255,0.06) 1px,transparent 1px);background-size:44px 44px;}
    .page-wrap{max-width:1100px;margin:0 auto;padding:0 5vw;}
    input,select{font-family:'Rajdhani',sans-serif;} input::placeholder{color:rgba(160,180,210,0.4);}
    ::-webkit-scrollbar{width:8px;height:8px;}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:4px;}
    .ea-btn{transition:transform .18s,box-shadow .18s,background .18s,border-color .18s;}
    .ea-btn:hover{transform:translateY(-2px);box-shadow:0 0 30px rgba(61,123,255,0.4);}
    .ea-btn:active{transform:translateY(0) scale(0.98);}
    @media(prefers-reduced-motion:reduce){.view-in,.ea-btn{animation:none;transition:none;}}
  `}</style>;
}
function Shell({children}){
  return <div style={{minHeight:"100vh",color:TEXT,fontFamily:FONT_BODY,background:"#0a0d18",overflowX:"hidden"}}>
    <Fonts/>
    <div style={{position:"fixed",inset:0,pointerEvents:"none",background:"radial-gradient(ellipse 60% 40% at 50% -5%, rgba(61,123,255,0.10), transparent 60%), radial-gradient(ellipse 45% 35% at 100% 100%, rgba(61,123,255,0.08), transparent 60%), radial-gradient(ellipse 45% 35% at 0% 100%, rgba(0,229,255,0.06), transparent 60%)"}}/>
    <div className="grid-bg" style={{position:"fixed",inset:0,pointerEvents:"none",opacity:0.5}}/>
    <div style={{position:"relative",minHeight:"100vh"}}>{children}</div>
  </div>;
}
function TPanel({children,hue=HUE,style={},onClick,className=""}){
  return <div onClick={onClick} className={"view-in "+className} style={{position:"relative",padding:22,background:"linear-gradient(160deg, rgba(61,123,255,0.05), rgba(10,15,28,0.5))",border:`1px solid ${hue}33`,clipPath:notch(16),backdropFilter:"blur(8px)",...style}}>
    <span style={{position:"absolute",left:0,top:0,width:11,height:11,borderLeft:`2px solid ${hue}`,borderTop:`2px solid ${hue}`}}/>
    {children}
  </div>;
}
function TungstenHead({word1,word2,size="clamp(2.4rem,5vw,3.6rem)"}){
  return <h2 style={{fontFamily:FONT_HEAD,fontWeight:700,textTransform:"uppercase",fontSize:size,lineHeight:0.9,letterSpacing:"0.04em",color:"#f4f8ff",margin:0,textShadow:"0 0 40px rgba(61,123,255,0.22)"}}>
    {word1} {word2&&<span style={{color:HUE}}>{word2}</span>}</h2>;
}
function Eyebrow({children}){
  return <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:8}}>
    <span style={{width:18,height:2,background:HUE}}/>
    <p style={{textTransform:"uppercase",fontSize:12,fontWeight:600,color:"#5b8dff",fontFamily:FONT_LABEL,letterSpacing:"0.34em",margin:0}}>{children}</p>
    <span style={{width:18,height:2,background:HUE}}/></div>;
}
function SectionLabel({children}){
  return <p style={{textTransform:"uppercase",fontSize:13,fontWeight:700,letterSpacing:"0.12em",color:"#7da6ff",fontFamily:FONT_LABEL,margin:"0 0 12px"}}>{children}</p>;
}
const fieldStyle={width:"100%",boxSizing:"border-box",padding:"11px 13px",background:"rgba(61,123,255,0.06)",border:"1px solid rgba(61,123,255,0.25)",color:"#ecf3ff",fontSize:15,fontFamily:FONT_LABEL,outline:"none",clipPath:notch(8)};
function notchBtn(active=true,hue=HUE){
  return {padding:"12px 22px",cursor:"pointer",textTransform:"uppercase",fontFamily:FONT_LABEL,fontWeight:700,fontSize:14,letterSpacing:"0.14em",color:active?"#eaf1ff":"rgba(200,215,255,0.6)",background:active?"rgba(61,123,255,0.18)":"rgba(255,255,255,0.03)",border:`1px solid ${active?hue:"rgba(120,150,220,0.25)"}`,clipPath:notch(10)};
}
function phaseBadge(phase){
  const m={registration_open:{label:"Registration open",color:"#3ddc84"},registration_closed:{label:"Registration closed",color:"#f5c453"},drafting:{label:"Draft day",color:"#9d6bff"},matches_live:{label:"Matches live",color:CYAN},settled:{label:"Finished",color:"rgba(200,215,255,0.5)"}};
  return m[phase]||m.registration_open;
}
const errBox={background:"rgba(255,70,85,0.1)",border:"1px solid rgba(255,70,85,0.4)",color:"#ff9aa3",padding:"9px 13px",clipPath:notch(8),fontSize:13,marginBottom:14,fontFamily:FONT_LABEL};
const okBox={background:"rgba(61,220,132,0.08)",border:"1px solid rgba(61,220,132,0.4)",color:"#86e6b0",padding:"9px 13px",clipPath:notch(8),fontSize:13,marginBottom:14,fontFamily:FONT_LABEL};
const labelTxt={fontSize:12,letterSpacing:"0.14em",textTransform:"uppercase",color:"#7da6ff",marginBottom:6,display:"block",fontFamily:FONT_LABEL,fontWeight:600};

/* ══════════════ HELPERS (was in supabase.js) ══════════════ */
function weekendWindows(sat){
  const d=new Date(sat+"T18:00:00");
  const day=(o,h,m=0)=>{const x=new Date(d);x.setDate(d.getDate()+o);x.setHours(h,m,0,0);return x.toISOString();};
  return {reg_opens:day(-5,0,0),reg_closes:day(-2,23,59),draft_at:day(-1,20,0),matches_start:day(0,18,0),matches_end:day(1,23,59)};
}
function computeAutoPhase(ev,now=new Date()){
  if(ev.phase_overridden)return ev.phase;
  const t=(d)=>d?new Date(d).getTime():null,n=now.getTime();
  if(t(ev.matches_end)&&n>t(ev.matches_end))return"settled";
  if(t(ev.matches_start)&&n>=t(ev.matches_start))return"matches_live";
  if(t(ev.draft_at)&&n>=t(ev.draft_at))return"drafting";
  if(t(ev.reg_closes)&&n>=t(ev.reg_closes))return"registration_closed";
  return"registration_open";
}
const fmt=(iso)=>iso?new Date(iso).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"}):"—";

/* ══════════════ SCORING (tunable) ══════════════ */
const SCORING = { winBonus:100, acsDivisor:4, perKill:1, perAssist:0.5 };

/* ══════════════ DRAFT PRICING (ported verbatim from old app) ══════════════ */
const RANKS = {
  Iron:      { bid: 300,  c: "#8d97a8", glow: "rgba(141,151,168,0.45)" },
  Bronze:    { bid: 500,  c: "#c08a52", glow: "rgba(192,138,82,0.45)" },
  Silver:    { bid: 800,  c: "#d7e1ee", glow: "rgba(215,225,238,0.40)" },
  Gold:      { bid: 1100, c: "#f5c453", glow: "rgba(245,196,83,0.45)" },
  Platinum:  { bid: 1500, c: "#3be8d8", glow: "rgba(59,232,216,0.45)" },
  Diamond:   { bid: 2000, c: "#c08bff", glow: "rgba(192,139,255,0.50)" },
  Ascendant: { bid: 2600, c: "#3ddc84", glow: "rgba(61,220,132,0.50)" },
  Immortal:  { bid: 3500, c: "#ff4d6d", glow: "rgba(255,77,109,0.55)" },
  Radiant:   { bid: 4500, c: "#fff3b0", glow: "rgba(255,243,176,0.60)" },
};
const RANK_LIST = Object.keys(RANKS);
const DRAFT_SLOTS = 4;              // players each captain drafts (old app)
const START_BUDGET = 10000;        // starting purse (old app)
const fmtMoney = (n)=> "$" + (n||0).toLocaleString();
const playerBidValue = (p)=> (RANKS[p.rank]?.bid ?? 0);
// reserve: the cheapest remaining slots a captain must still afford after this pick
const reserveFor = (t, availablePlayers)=>{
  const slotsAfterThisPick = Math.max(DRAFT_SLOTS - t.roster.length - 1, 0);
  if (slotsAfterThisPick === 0) return 0;
  const cheapest = availablePlayers.map(playerBidValue).sort((a,b)=>a-b).slice(0, slotsAfterThisPick);
  return cheapest.reduce((s,v)=>s+v, 0);
};
const maxAllowedBid = (t, availablePlayers=[])=> t.budget - reserveFor(t, availablePlayers);
const requiredBid = (b)=> (b.leaderId ? b.currentBid + 100 : b.startingBid);
function matchPoints(r){
  return (r.won?SCORING.winBonus:0) + ((r.acs||0)/SCORING.acsDivisor) + ((r.k||0)*SCORING.perKill) + ((r.a||0)*SCORING.perAssist);
}
// roll per-match rows into a season board ranked by AVERAGE points/match
function seasonBoardFrom(rows){
  const by={};
  rows.forEach(r=>{
    if(!by[r.name])by[r.name]={name:r.name,games:0,pts:0,k:0,a:0,acsSum:0,wins:0,unverified:0};
    const p=by[r.name];
    p.games++; p.pts+=matchPoints(r); p.k+=r.k||0; p.a+=r.a||0; p.acsSum+=r.acs||0;
    if(r.won)p.wins++; if(r.unverified)p.unverified++;
  });
  return Object.values(by).map(p=>{
    p.avg=p.games?p.pts/p.games:0; p.acs=p.games?Math.round(p.acsSum/p.games):0; return p;
  }).sort((a,b)=>b.avg-a.avg);
}
const CONF_THRESHOLD = 0.85;
const lowConf = (v)=> typeof v==="number" && v<CONF_THRESHOLD;

/* ══════════════ AI SCOREBOARD READ (free, via Puter → Claude) ══════════════ */
// Calls Claude through Puter.js (loaded from index.html). No API key, runs in
// the browser, no CORS. Puter's image-passing signature isn't documented, so we
// try several call shapes and use whichever returns. Throws on total failure so
// the UI shows an error the host can act on.
async function aiReadScoreboard(dataUrl){
  // Preview (no Supabase env) returns a simulated read so the flow is clickable.
  if(!HAS_SUPABASE){
    await new Promise(r=>setTimeout(r,1200));
    return {
      map:"Ascent", scoreA:13, scoreB:9, winningTeam:"A",
      rows:[
        {scoreName:"Vex#NA1",team:"A",k:22,d:13,a:5,acs:280,conf:{k:0.99,a:0.98,acs:0.96}},
        {scoreName:"Kiro#2747",team:"A",k:18,d:15,a:7,acs:245,conf:{k:0.98,a:0.95,acs:0.71}},
        {scoreName:"rumer#MIN",team:"A",k:17,d:14,a:8,acs:230,conf:{k:0.99,a:0.62,acs:0.97}},
        {scoreName:"Nova#777",team:"B",k:15,d:18,a:9,acs:210,conf:{k:0.97,a:0.99,acs:0.94}},
        {scoreName:"Echo#404",team:"B",k:12,d:19,a:6,acs:190,conf:{k:0.99,a:0.97,acs:0.99}},
        {scoreName:"R1OT#xx",team:"B",k:25,d:16,a:4,acs:310,conf:{k:0.93,a:0.98,acs:0.9}},
      ]
    };
  }
  if(typeof window==="undefined" || !window.puter || !window.puter.ai){
    throw new Error("Puter not loaded — check the script tag in index.html.");
  }
  const prompt = `You are reading a Valorant end-of-game scoreboard screenshot. Return ONLY valid JSON, no prose, no markdown fences. Shape:
{"map":string,"scoreA":number,"scoreB":number,"winningTeam":"A"|"B","rows":[{"scoreName":string,"team":"A"|"B","k":number,"d":number,"a":number,"acs":number,"conf":{"k":number,"a":number,"acs":number}}]}
"team" A = the winning side's table, B = the other. conf values are your 0..1 confidence per field. If a value is unreadable, give your best guess and a low conf. scoreName is the player's in-game name exactly as shown.`;
  const model = "claude-sonnet-4-6";
  const p = window.puter.ai;
  // Ordered call-shape attempts (Puter's vision signature is under-documented).
  const attempts = [
    ()=> p.chat(prompt, dataUrl, { model }),
    ()=> p.chat(prompt, { model, image: dataUrl }),
    ()=> p.chat([{ role:"user", content:[ {type:"text",text:prompt}, {type:"image_url",image_url:{url:dataUrl}} ]}], { model }),
    ()=> p.chat([{ role:"user", content:[ {type:"text",text:prompt}, {type:"file",puter_path:dataUrl} ]}], { model }),
  ];
  let resp=null, lastErr=null;
  for(const tryCall of attempts){
    try{ resp = await tryCall(); if(resp) break; }
    catch(e){ lastErr=e; }
  }
  if(!resp) throw new Error("Vision read failed: "+(lastErr&&lastErr.message?lastErr.message:String(lastErr)));
  // Normalise Puter's response shape into plain text.
  let text="";
  if(typeof resp==="string") text=resp;
  else if(resp.message&&resp.message.content){
    const c=resp.message.content;
    text = Array.isArray(c) ? c.map(b=>b.text||"").join("") : String(c);
  }
  else if(resp.text) text=resp.text;
  else text=JSON.stringify(resp);
  text = text.replace(/```json|```/g,"").trim();
  return JSON.parse(text);
}
function resolveName(scoreName, registered, nameMap){
  if(nameMap[scoreName]) return nameMap[scoreName];
  const base=(scoreName||"").split("#")[0].toLowerCase();
  const hit=registered.find(p=>(p.name||"").toLowerCase()===base);
  return hit?hit.name:null;
}

/* ══════════════ DATA LAYER — real Supabase OR mock ══════════════ */
const HAS_SUPABASE = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);

let DB;
if (HAS_SUPABASE) {
  // Real backend.
  const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
  DB = {
    live:true, sb,
    auth:{
      signUpEmail:(e,p)=>sb.auth.signUp({email:e,password:p}),
      signInEmail:(e,p)=>sb.auth.signInWithPassword({email:e,password:p}),
      sendMagicLink:(e)=>sb.auth.signInWithOtp({email:e,options:{shouldCreateUser:true}}),
      signOut:()=>sb.auth.signOut(),
      getSession:()=>sb.auth.getSession(),
      onChange:(cb)=>sb.auth.onAuthStateChange((_e,s)=>cb(s)),
    },
    createCommunity:(name,slug,dn)=>sb.rpc("create_community",{p_name:name,p_slug:slug,p_display_name:dn}),
    joinCommunity:(slug,dn,wc)=>sb.rpc("join_community",{p_slug:slug,p_display_name:dn,p_wants_captain:wc}),
    async profile(){const{data:{user}}=await sb.auth.getUser();if(!user)return null;const{data}=await sb.from("users").select("*, communities(*)").eq("id",user.id).maybeSingle();return data;},
    seasonsActive:()=>sb.from("seasons").select("*").eq("status","active").maybeSingle(),
    seasonsCreate:(cid,p)=>sb.from("seasons").insert({community_id:cid,...p}).select().single(),
    eventsForSeason:(sid)=>sb.from("events").select("*").eq("season_id",sid).order("reg_opens",{ascending:true}),
    eventsCreate:(cid,sid,p)=>sb.from("events").insert({community_id:cid,season_id:sid,...p}).select().single(),
    async regsForEvent(eventId){const{data}=await sb.from("registrations").select("*, users(display_name, wants_captain)").eq("event_id",eventId);return (data||[]).map(r=>({id:r.id,name:r.users?.display_name,wantsCaptain:r.users?.wants_captain,isCaptain:r.is_captain}));},
    async myReg(eventId){const{data:{user}}=await sb.auth.getUser();if(!user)return null;const{data}=await sb.from("registrations").select("*").eq("event_id",eventId).eq("user_id",user.id).maybeSingle();return data;},
    async register(cid,eventId){const{data:{user}}=await sb.auth.getUser();return sb.from("registrations").insert({community_id:cid,event_id:eventId,user_id:user.id}).select().single();},
    async unregister(eventId){const{data:{user}}=await sb.auth.getUser();return sb.from("registrations").delete().eq("event_id",eventId).eq("user_id",user.id);},
    async setMyWantsCaptain(val){const{data:{user}}=await sb.auth.getUser();return sb.from("users").update({wants_captain:val}).eq("id",user.id);},

    // ── match results / leaderboard ──
    async resultsForSeason(seasonId){
      // join through events so we get this season's rows with player names
      const{data:evs}=await sb.from("events").select("id").eq("season_id",seasonId);
      const ids=(evs||[]).map(e=>e.id); if(!ids.length)return [];
      const{data}=await sb.from("match_results").select("*, users(display_name), events(weekend_label)").in("event_id",ids);
      return (data||[]).map(r=>({
        id:r.id, eventId:r.event_id, name:r.users?.display_name,
        weekend:r.events?.weekend_label,
        k:r.stat_payload?.k||0, a:r.stat_payload?.a||0, acs:r.stat_payload?.acs||0,
        won:r.team_won, unverified:!!r.stat_payload?.unverified,
      }));
    },
    async addResult(cid,eventId,userId,row){
      const stat={k:+row.k||0,a:+row.a||0,acs:+row.acs||0,unverified:!!row.unverified};
      const pts=matchPoints({k:stat.k,a:stat.a,acs:stat.acs,won:!!row.won});
      return sb.from("match_results").insert({community_id:cid,event_id:eventId,user_id:userId,stat_payload:stat,team_won:!!row.won,points_computed:pts}).select().single();
    },
    async removeResult(id){return sb.from("match_results").delete().eq("id",id);},
    async verifyResult(id){
      const{data:cur}=await sb.from("match_results").select("stat_payload").eq("id",id).single();
      const sp={...(cur?.stat_payload||{}),unverified:false};
      return sb.from("match_results").update({stat_payload:sp}).eq("id",id);
    },
    // resolve a display_name -> user_id within the community (for import save)
    async userIdByName(cid,name){const{data}=await sb.from("users").select("id,display_name").eq("community_id",cid).eq("display_name",name).maybeSingle();return data?.id||null;},
    // name-map memory persisted on the community row (jsonb settings)
    async getNameMap(cid){const{data}=await sb.from("communities").select("name_map").eq("id",cid).maybeSingle();return data?.name_map||{};},
    async setNameMap(cid,map){return sb.from("communities").update({name_map:map}).eq("id",cid);},

    // ── draft (Stage 1: load teams + ranked players for a weekend) ──
    async draftPlayers(eventId){
      // registered players with their per-weekend rank
      const{data}=await sb.from("registrations").select("user_id, rank, is_captain, users(display_name)").eq("event_id",eventId);
      return (data||[]).map(r=>({id:r.user_id, name:r.users?.display_name, rank:r.rank, isCaptain:r.is_captain}));
    },
    async draftTeams(eventId){
      const{data}=await sb.from("teams").select("id, name, budget, captain_user_id, users:captain_user_id(display_name), team_players(user_id, draft_price)").eq("event_id",eventId);
      return (data||[]).map(t=>({id:t.id, name:t.name, budget:t.budget, captainId:t.captain_user_id, captain:t.users?.display_name, roster:(t.team_players||[]).map(tp=>tp.user_id)}));
    },
    async setPlayerRank(eventId,userId,rank){return sb.from("registrations").update({rank}).eq("event_id",eventId).eq("user_id",userId);},
    async createTeamForCaptain(cid,eventId,captainUserId,name){return sb.from("teams").insert({community_id:cid,event_id:eventId,captain_user_id:captainUserId,name,budget:START_BUDGET}).select().single();},

    // ── live draft state (realtime) ──
    async getDraftState(eventId){const{data}=await sb.from("draft_state").select("state").eq("event_id",eventId).maybeSingle();return data?.state||null;},
    async setDraftState(cid,eventId,state){return sb.from("draft_state").upsert({event_id:eventId,community_id:cid,state,updated_at:new Date().toISOString()},{onConflict:"event_id"});},
    subscribeDraft(eventId,onState){
      const ch=sb.channel("draft_"+eventId)
        .on("postgres_changes",{event:"*",schema:"public",table:"draft_state",filter:"event_id=eq."+eventId},(payload)=>{
          if(payload.new&&payload.new.state)onState(payload.new.state);
        }).subscribe();
      return ()=>{sb.removeChannel(ch);};
    },
    // commit a finished draft: write team_players rows + final budgets
    async commitDraftResults(cid,eventId,teams){
      for(const t of teams){
        await sb.from("teams").update({budget:t.budget,name:t.name}).eq("id",t.id);
        for(const pid of t.roster){
          const price=(t.prices&&t.prices[pid])||0;
          await sb.from("team_players").upsert({team_id:t.id,user_id:pid,community_id:cid,draft_price:price},{onConflict:"team_id,user_id"});
        }
      }
      return {ok:true};
    },
  };
} else {
  // Mock backend for preview. In-memory; resets on reload.
  const store = {
    session:null, profile:null, role:null,
    season:null, events:[], regs:{},
  };
  const seedRegs = ()=>{ store.regs={0:[
    {id:"m1",name:"Vex",wantsCaptain:true,isCaptain:false},
    {id:"m2",name:"Kiro",wantsCaptain:true,isCaptain:false},
    {id:"m3",name:"Nova",wantsCaptain:false,isCaptain:false},
    {id:"m4",name:"Echo",wantsCaptain:false,isCaptain:false},
    {id:"m5",name:"Riot",wantsCaptain:true,isCaptain:false},
  ]};};
  const myName=()=>store.role==="host"?"Rumer":"test";
  const ok=(data)=>Promise.resolve({data,error:null});
  DB = {
    live:false,
    auth:{
      signUpEmail:()=>ok({}), signInEmail:()=>{store.session={user:{id:"demo"}};return ok({});},
      sendMagicLink:()=>ok({}), signOut:()=>{store.session=null;store.profile=null;store.role=null;return ok({});},
      getSession:()=>ok({session:store.session}),
      onChange:()=>({data:{subscription:{unsubscribe(){}}}}),
    },
    createCommunity:(name,slug,dn)=>{store.role="host";store.profile={display_name:dn||"Rumer",role:"host",community_id:"c1",communities:{name:name,slug:slug}};return ok({});},
    joinCommunity:(slug,dn,wc)=>{store.role="player";store.profile={display_name:dn||"test",role:"player",community_id:"c1",communities:{name:"Minaal.GG",slug:slug}};return ok({});},
    profile:()=>Promise.resolve(store.profile),
    seasonsActive:()=>ok(store.season),
    seasonsCreate:(cid,p)=>{store.season={id:"s1",...p};return ok(store.season);},
    eventsForSeason:()=>ok(store.events),
    eventsCreate:(cid,sid,p)=>{const ev={id:store.events.length,...p};store.events.push(ev);return ok(ev);},
    regsForEvent:(eventId)=>Promise.resolve(store.regs[eventId]||[]),
    myReg:(eventId)=>Promise.resolve((store.regs[eventId]||[]).find(r=>r.name===myName())||null),
    register:(cid,eventId)=>{if(!store.regs[eventId])store.regs[eventId]=[];store.regs[eventId].push({id:"me",name:myName(),wantsCaptain:false,isCaptain:false});return ok({});},
    unregister:(eventId)=>{const a=store.regs[eventId]||[];const i=a.findIndex(r=>r.name===myName());if(i>=0)a.splice(i,1);return ok({});},
    setMyWantsCaptain:(val)=>{for(const id in store.regs){const r=store.regs[id].find(r=>r.name===myName());if(r)r.wantsCaptain=val;}return ok({});},

    // ── match results / leaderboard (mock) ──
    resultsForSeason:()=>Promise.resolve(store.results||[]),
    addResult:(cid,eventId,userId,row)=>{
      if(!store.results)store.results=[];
      const ev=store.events.find(e=>e.id===eventId);
      store.results.push({id:"r"+(store._rid=(store._rid||0)+1),eventId,name:userId,weekend:ev?ev.weekend_label:("Wk "+eventId),k:+row.k||0,a:+row.a||0,acs:+row.acs||0,won:!!row.won,unverified:!!row.unverified});
      return ok({});
    },
    removeResult:(id)=>{store.results=(store.results||[]).filter(r=>r.id!==id);return ok({});},
    verifyResult:(id)=>{const r=(store.results||[]).find(x=>x.id===id);if(r)r.unverified=false;return ok({});},
    userIdByName:(cid,name)=>Promise.resolve(name), // mock: name IS the id
    getNameMap:()=>Promise.resolve(store.nameMap||{}),
    setNameMap:(cid,map)=>{store.nameMap=map;return ok({});},

    // ── draft (mock) ──
    draftPlayers:(eventId)=>{
      const regs=store.regs[eventId]||[];
      const seedRank={Vex:"Immortal",Kiro:"Diamond",Nova:"Platinum",Echo:"Gold",Riot:"Ascendant",test:"Silver"};
      return Promise.resolve(regs.map(r=>({id:r.id||r.name,name:r.name,rank:r.rank||seedRank[r.name]||"Gold",isCaptain:r.isCaptain})));
    },
    draftTeams:(eventId)=>{
      if(!store.teams)store.teams=[
        {id:"tm1",name:"CRIMSON PULSE",budget:START_BUDGET,captainId:"m1",captain:"Vex",roster:[]},
        {id:"tm2",name:"NEON SYNDICATE",budget:START_BUDGET,captainId:"m2",captain:"Kiro",roster:[]},
      ];
      return Promise.resolve(store.teams);
    },
    setPlayerRank:(eventId,userId,rank)=>{const r=(store.regs[eventId]||[]).find(x=>(x.id||x.name)===userId);if(r)r.rank=rank;return ok({});},
    createTeamForCaptain:(cid,eventId,capId,name)=>{if(!store.teams)store.teams=[];const t={id:"tm"+(store.teams.length+1),name,budget:START_BUDGET,captainId:capId,captain:capId,roster:[]};store.teams.push(t);return ok(t);},

    // ── live draft state (mock; same-tab realtime via callback registry) ──
    _draftState:null, _draftSubs:[],
    getDraftState:function(){return Promise.resolve(this._draftState);},
    setDraftState:function(cid,eventId,state){this._draftState=state;this._draftSubs.forEach(cb=>{try{cb(state);}catch(e){}});return ok({});},
    subscribeDraft:function(eventId,onState){this._draftSubs.push(onState);return ()=>{this._draftSubs=this._draftSubs.filter(c=>c!==onState);};},
    commitDraftResults:function(cid,eventId,teams){store.teams=teams;return ok({ok:true});},
    _store:store, _seedRegs:seedRegs,
  };
  // On season create, seed demo regs + a couple weekends of results so previews aren't empty.
  const origCreate = DB.seasonsCreate;
  DB.seasonsCreate = (cid,p)=>{ const r=origCreate(cid,p); seedRegs(); seedResults(); return r; };
  function seedResults(){
    store.results=[
      {id:"r1",eventId:0,name:"Vex",weekend:"Week 1",k:22,a:5,acs:280,won:true,unverified:false},
      {id:"r2",eventId:0,name:"Kiro",weekend:"Week 1",k:18,a:7,acs:245,won:true,unverified:false},
      {id:"r3",eventId:0,name:"Nova",weekend:"Week 1",k:15,a:9,acs:210,won:false,unverified:false},
      {id:"r4",eventId:0,name:"Echo",weekend:"Week 1",k:12,a:6,acs:190,won:false,unverified:false},
      {id:"r5",eventId:0,name:"Riot",weekend:"Week 1",k:25,a:4,acs:310,won:false,unverified:false},
      {id:"r6",eventId:0,name:"test",weekend:"Week 1",k:17,a:8,acs:230,won:true,unverified:false},
    ];
    store._rid=6;
  }
}

/* ══════════════ APP ROOT ══════════════ */
export default function App(){
  const [session,setSession]=useState(null);
  const [profile,setProfile]=useState(null);
  const [loading,setLoading]=useState(true);
  const [openEvent,setOpenEvent]=useState(null);
  const [showBoard,setShowBoard]=useState(false);

  useEffect(()=>{
    DB.auth.getSession().then(({data})=>setSession(data.session));
    const {data:listener}=DB.auth.onChange((s)=>setSession(s));
    return ()=>listener?.subscription?.unsubscribe();
  },[]);
  useEffect(()=>{
    if(!session){setProfile(null);setLoading(false);return;}
    setLoading(true);
    DB.profile().then((p)=>{setProfile(p);setLoading(false);});
  },[session]);

  // demo helpers let the preview bar jump screens without real auth
  const demo = !DB.live ? {
    setSession,setProfile,
    goOnboard:()=>{DB._store.session={user:{id:"demo"}};DB._store.profile=null;DB._store.role=null;setSession(DB._store.session);setProfile(null);setOpenEvent(null);},
    goHost:()=>{DB.createCommunity("Minaal.GG","minaal-gg","Rumer").then(()=>{DB._store.session={user:{id:"demo"}};setSession(DB._store.session);DB.profile().then(setProfile);setOpenEvent(null);});},
    goPlayer:()=>{DB.joinCommunity("minaal-gg","test",false).then(()=>{DB._store.session={user:{id:"demo"}};setSession(DB._store.session);DB.profile().then(setProfile);setOpenEvent(null);});},
    signOut:()=>{DB.auth.signOut();setSession(null);setProfile(null);setOpenEvent(null);},
  } : null;

  let view;
  if(loading) view=<Shell><div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}><TPanel><p style={{margin:0,color:MUTE,letterSpacing:"0.1em",fontFamily:FONT_LABEL}}>LOADING…</p></TPanel></div></Shell>;
  else if(!session) view=<AuthScreen onAuthed={()=>{ if(!DB.live){DB._store.session={user:{id:"demo"}};setSession(DB._store.session);} }}/>;
  else if(!profile) view=<Onboarding onDone={()=>DB.profile().then(setProfile)} onSignOut={()=>{DB.auth.signOut();setSession(null);}}/>;
  else if(openEvent!==null) view=<WeekendDetail profile={profile} eventId={openEvent} onBack={()=>setOpenEvent(null)} onSignOut={()=>{DB.auth.signOut();setSession(null);setProfile(null);}}/>;
  else if(showBoard) view=<Leaderboard profile={profile} onBack={()=>setShowBoard(false)} onSignOut={()=>{DB.auth.signOut();setSession(null);setProfile(null);setShowBoard(false);}}/>;
  else view=<Home profile={profile} onOpenEvent={setOpenEvent} onShowBoard={()=>setShowBoard(true)} onSignOut={()=>{DB.auth.signOut();setSession(null);setProfile(null);}}/>;

  return <>{demo && <DemoBar session={session} profile={profile} openEvent={openEvent} demo={demo}/>}{view}</>;
}

/* ══════════════ DEMO BAR (preview only) ══════════════ */
function DemoBar({session,profile,openEvent,demo}){
  const isHost=profile?.role==="host";
  const stage = !session ? "auth" : !profile ? "onboard" : "home";
  const sbtn=(txt,on,fn)=>(<button onClick={fn} className="ea-btn" style={{padding:"7px 13px",cursor:"pointer",textTransform:"uppercase",fontFamily:FONT_LABEL,fontWeight:700,fontSize:12,letterSpacing:"0.1em",background:on?"rgba(61,123,255,0.18)":"rgba(255,255,255,0.03)",color:on?"#eaf1ff":"rgba(200,215,255,0.6)",border:`1px solid ${on?HUE:"rgba(120,150,220,0.25)"}`,clipPath:notch(8)}}>{txt}</button>);
  return <div style={{position:"sticky",top:0,zIndex:50,background:"rgba(8,11,20,0.94)",borderBottom:"1px solid rgba(61,123,255,0.3)",padding:"8px 14px",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",fontFamily:FONT_LABEL}}>
    <span style={{color:"#7da6ff",fontWeight:700,letterSpacing:"0.1em",fontSize:12,textTransform:"uppercase"}}>DEMO ·</span>
    {sbtn("1 Sign in",stage==="auth",()=>demo.signOut())}
    {sbtn("2 Onboard",stage==="onboard",demo.goOnboard)}
    {sbtn("3 Host view",stage==="home"&&isHost,demo.goHost)}
    {sbtn("4 Player view",stage==="home"&&!isHost,demo.goPlayer)}
    <span style={{color:"rgba(200,215,255,0.4)",fontSize:11,marginLeft:"auto"}}>mock data · no database</span>
  </div>;
}

function Brand(){
  return <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
    <div style={{width:6,height:30,background:CYAN,boxShadow:`0 0 12px ${CYAN}`}}/>
    <div style={{fontFamily:FONT_HEAD,fontWeight:700,fontSize:30,letterSpacing:"0.04em",color:"#fff"}}>VOLT<span style={{color:CYAN}}> // </span>LEAGUE</div>
  </div>;
}
const center={minHeight:"calc(100vh - 0px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20};

/* ══════════════ AUTH ══════════════ */
function AuthScreen({onAuthed}){
  const [mode,setMode]=useState("signin");
  const [email,setEmail]=useState(""),[pw,setPw]=useState(""),[msg,setMsg]=useState(null),[busy,setBusy]=useState(false);
  const linkBtn={background:"none",border:"none",color:CYAN,cursor:"pointer",padding:0,fontFamily:FONT_LABEL,fontSize:13,letterSpacing:"0.04em"};
  async function go(){
    setMsg(null);setBusy(true);
    try{
      if(mode==="magic"){const{error}=await DB.auth.sendMagicLink(email);if(error)throw error;setMsg({ok:true,text:"Check your email for a login link."});}
      else if(mode==="signup"){const{error}=await DB.auth.signUpEmail(email,pw);if(error)throw error;setMsg({ok:true,text:"Account made. Confirm via email if asked, then sign in."});}
      else{const{error}=await DB.auth.signInEmail(email,pw);if(error)throw error;onAuthed&&onAuthed();}
    }catch(e){setMsg({ok:false,text:e.message});}
    setBusy(false);
  }
  return <Shell><div style={center}><div style={{width:"100%",maxWidth:440}}>
    <Brand/>
    <TPanel>
      <p style={{color:MUTE,margin:"0 0 18px",fontFamily:FONT_LABEL,fontSize:14,letterSpacing:"0.04em"}}>Sign in to run or join a league.</p>
      {msg&&<div style={msg.ok?okBox:errBox}>{msg.text}</div>}
      <label style={labelTxt}>Email</label>
      <input style={{...fieldStyle,marginBottom:14}} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@email.com"/>
      {mode!=="magic"&&<><label style={labelTxt}>Password</label>
        <input style={{...fieldStyle,marginBottom:14}} type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••"/></>}
      <button className="ea-btn" style={{...notchBtn(true),width:"100%"}} disabled={busy} onClick={go}>{busy?"…":mode==="magic"?"Send Login Link →":mode==="signup"?"Create Account →":"Sign In →"}</button>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:16}}>
        <button onClick={()=>setMode(mode==="signup"?"signin":"signup")} style={linkBtn}>{mode==="signup"?"Have an account? Sign in":"New here? Create account"}</button>
        <button onClick={()=>setMode(mode==="magic"?"signin":"magic")} style={{...linkBtn,color:"#7da6ff"}}>{mode==="magic"?"Use password":"Email me a link"}</button>
      </div>
    </TPanel>
  </div></div></Shell>;
}

/* ══════════════ ONBOARDING ══════════════ */
function Onboarding({onDone,onSignOut}){
  const [tab,setTab]=useState("join");
  const [name,setName]=useState(""),[code,setCode]=useState(""),[commName,setCommName]=useState("");
  const [wantsCaptain,setWantsCaptain]=useState(false),[msg,setMsg]=useState(null),[busy,setBusy]=useState(false);
  const slugify=(s)=>s.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  async function submit(){
    setMsg(null);setBusy(true);
    try{
      if(!name.trim())throw new Error("Enter your display name.");
      if(tab==="host"){if(!commName.trim())throw new Error("Enter a community name.");const{error}=await DB.createCommunity(commName,slugify(commName),name);if(error)throw error;}
      else{if(!code.trim())throw new Error("Enter the community code.");const{error}=await DB.joinCommunity(slugify(code),name,wantsCaptain);if(error)throw error;}
      onDone();
    }catch(e){setMsg({ok:false,text:e.message});setBusy(false);}
  }
  const tabBtn=(id,text)=>(<button onClick={()=>setTab(id)} style={{flex:1,padding:"11px",cursor:"pointer",fontFamily:FONT_LABEL,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",fontSize:13,background:tab===id?"rgba(61,123,255,0.16)":"rgba(255,255,255,0.03)",color:tab===id?"#aec6ff":"rgba(200,215,255,0.55)",border:`1px solid ${tab===id?HUE:"rgba(120,150,220,0.2)"}`,clipPath:notch(9),marginRight:id==="join"?8:0}}>{text}</button>);
  return <Shell><div style={center}><div style={{width:"100%",maxWidth:460}}>
    <Brand/>
    <TPanel>
      <Eyebrow>Welcome</Eyebrow>
      <TungstenHead word1="Join or" word2="Create"/>
      <p style={{color:MUTE,margin:"10px 0 18px",fontFamily:FONT_LABEL,fontSize:14}}>Join a community, or start your own league.</p>
      <div style={{display:"flex",marginBottom:20}}>{tabBtn("join","Join as player")}{tabBtn("host","Start a league")}</div>
      {msg&&<div style={msg.ok?okBox:errBox}>{msg.text}</div>}
      <label style={labelTxt}>Your display name</label>
      <input style={{...fieldStyle,marginBottom:14}} value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Phoenix"/>
      {tab==="join"?<>
        <label style={labelTxt}>Community code</label>
        <input style={{...fieldStyle,marginBottom:14}} value={code} onChange={e=>setCode(e.target.value)} placeholder="given by your host"/>
        <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",color:"#cfe0f0",fontSize:14,marginBottom:14,fontFamily:FONT_LABEL}}>
          <input type="checkbox" checked={wantsCaptain} onChange={e=>setWantsCaptain(e.target.checked)}/>I'm willing to be a captain</label>
      </>:<>
        <label style={labelTxt}>Community name</label>
        <input style={{...fieldStyle,marginBottom:14}} value={commName} onChange={e=>setCommName(e.target.value)} placeholder="e.g. Karachi Valorant Club"/>
        <div style={okBox}>Players join using the code: <b style={{color:CYAN}}>{commName?slugify(commName):"your-name-here"}</b></div>
      </>}
      <button className="ea-btn" style={{...notchBtn(true),width:"100%"}} disabled={busy} onClick={submit}>{busy?"…":tab==="host"?"Create League →":"Join →"}</button>
      <button onClick={onSignOut} style={{...notchBtn(false),width:"100%",marginTop:12}}>Sign out</button>
    </TPanel>
  </div></div></Shell>;
}

/* ══════════════ HOME (season hub) ══════════════ */
function Home({profile,onOpenEvent,onShowBoard,onSignOut}){
  const isHost=profile.role==="host";
  return <Shell><div className="page-wrap" style={{paddingTop:30,paddingBottom:50}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
      <Brand/>
      <div style={{display:"flex",gap:8}}>
        <button className="ea-btn" onClick={onShowBoard} style={notchBtn(false)}>Leaderboard</button>
        <button className="ea-btn" onClick={onSignOut} style={notchBtn(false)}>Sign out</button>
      </div>
    </div>
    <TPanel style={{padding:"14px 18px",marginBottom:16}}>
      <p style={{margin:0,fontFamily:FONT_MONO,fontSize:13,letterSpacing:"0.04em",color:"rgba(200,215,255,0.75)"}}>
        <b style={{color:"#fff"}}>{profile.display_name}</b> · <span style={{color:isHost?"#f5c453":CYAN}}>{isHost?"HOST":"PLAYER"}</span> · {profile.communities?.name}{isHost&&<> · CODE <b style={{color:CYAN}}>{profile.communities?.slug}</b></>}</p>
    </TPanel>
    <SeasonScreen profile={profile} onOpenEvent={onOpenEvent}/>
  </div></Shell>;
}

/* ══════════════ SEASON ══════════════ */
function SeasonScreen({profile,onOpenEvent}){
  const isHost=profile.role==="host";
  const [season,setSeason]=useState(null),[evs,setEvs]=useState([]),[loading,setLoading]=useState(true),[counts,setCounts]=useState({});
  async function load(){
    setLoading(true);
    const {data:s}=await DB.seasonsActive();setSeason(s||null);
    if(s){const {data:e}=await DB.eventsForSeason(s.id);const list=e||[];setEvs(list);
      const c={};for(const ev of list){c[ev.id]=(await DB.regsForEvent(ev.id)).length;}setCounts(c);}
    else setEvs([]);
    setLoading(false);
  }
  useEffect(()=>{load();},[]);
  if(loading)return <TPanel><p style={{textAlign:"center",color:MUTE,margin:0,fontFamily:FONT_LABEL,letterSpacing:"0.1em"}}>LOADING SEASON…</p></TPanel>;
  if(!season)return isHost?<CreateSeason profile={profile} onCreated={load}/>:<TPanel><Eyebrow>Season</Eyebrow><TungstenHead word1="No Active" word2="Season"/><p style={{color:MUTE,marginTop:12,fontFamily:FONT_LABEL,fontSize:15}}>Your host hasn't started a season yet. Check back soon.</p></TPanel>;
  return <div style={{display:"flex",flexDirection:"column",gap:14}}>
    <TPanel>
      <Eyebrow>Active Season</Eyebrow>
      <TungstenHead word1={season.name.split(" ")[0]||season.name} word2={season.name.split(" ").slice(1).join(" ")}/>
      <p style={{color:MUTE,marginTop:10,fontFamily:FONT_MONO,fontSize:13,letterSpacing:"0.06em"}}>{evs.length} WEEKEND{evs.length===1?"":"S"} · {fmt(season.starts_at)} → {fmt(season.ends_at)}</p>
    </TPanel>
    <SectionLabel>Weekend Schedule</SectionLabel>
    {evs.map(ev=><WeekendRow key={ev.id} ev={ev} count={counts[ev.id]||0} onOpen={()=>onOpenEvent(ev.id)}/>)}
  </div>;
}
function WeekendRow({ev,count,onOpen}){
  const phase=computeAutoPhase(ev),b=phaseBadge(phase),settled=phase==="settled";
  return <TPanel hue={settled?"#5a6b80":b.color} onClick={onOpen} className="ea-btn" style={{padding:16,opacity:settled?0.7:1,borderLeft:`3px solid ${b.color}`,cursor:"pointer"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
      <div>
        <div style={{fontFamily:FONT_HEAD,fontWeight:700,fontSize:22,color:"#f4f8ff",letterSpacing:"0.04em",textTransform:"uppercase"}}>{ev.weekend_label}</div>
        <div style={{color:"rgba(200,215,255,0.6)",fontSize:12,marginTop:4,fontFamily:FONT_MONO,letterSpacing:"0.02em"}}>REG {fmt(ev.reg_opens)}–{fmt(ev.reg_closes)} · DRAFT {fmt(ev.draft_at)} · MATCHES {fmt(ev.matches_start)}–{fmt(ev.matches_end)}</div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        {count>0&&<span style={{fontFamily:FONT_MONO,color:"#7da6ff",fontSize:12,letterSpacing:"0.05em"}}>{count} IN</span>}
        <span style={{padding:"5px 13px",fontSize:11,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:b.color,border:`1px solid ${b.color}66`,background:`${b.color}1a`,clipPath:notch(7),fontFamily:FONT_LABEL,whiteSpace:"nowrap"}}>{b.label}</span>
        <span style={{color:"#7da6ff",fontSize:18}}>›</span>
      </div>
    </div>
  </TPanel>;
}
function CreateSeason({profile,onCreated}){
  const [name,setName]=useState(""),[count,setCount]=useState(4),[dates,setDates]=useState(["","","",""]),[busy,setBusy]=useState(false),[error,setError]=useState(null);
  function setCountSafe(n){const v=Math.max(1,Math.min(8,n));setCount(v);setDates(p=>{const x=p.slice(0,v);while(x.length<v)x.push("");return x;});}
  async function create(){
    setError(null);
    if(!name.trim())return setError("Give the season a name.");
    if(dates.some(d=>!d))return setError("Pick a Saturday date for every weekend.");
    setBusy(true);
    try{
      const sorted=[...dates].sort();
      const first=weekendWindows(sorted[0]),last=weekendWindows(sorted[sorted.length-1]);
      const {data:s,error:se}=await DB.seasonsCreate(profile.community_id,{name:name.trim(),status:"active",starts_at:first.reg_opens.slice(0,10),ends_at:last.matches_end.slice(0,10)});
      if(se)throw se;
      for(let i=0;i<sorted.length;i++){const w=weekendWindows(sorted[i]);const {error:ee}=await DB.eventsCreate(profile.community_id,s.id,{weekend_label:`Week ${i+1}`,phase:"registration_open",...w});if(ee)throw ee;}
      onCreated();
    }catch(e){setError(e.message);setBusy(false);}
  }
  return <TPanel>
    <Eyebrow>Setup</Eyebrow>
    <TungstenHead word1="Start a" word2="Season"/>
    <p style={{color:MUTE,margin:"10px 0 20px",fontFamily:FONT_LABEL,fontSize:15}}>Name it, choose how many weekends, and pick each weekend's Saturday (match day). The rest of the schedule fills in automatically.</p>
    {error&&<div style={errBox}>{error}</div>}
    <SectionLabel>1 · Season name</SectionLabel>
    <input style={{...fieldStyle,marginBottom:20}} value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. June Season"/>
    <SectionLabel>2 · Number of weekends</SectionLabel>
    <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:20}}>
      <button className="ea-btn" style={notchBtn(false)} onClick={()=>setCountSafe(count-1)}>–</button>
      <span style={{fontFamily:FONT_MONO,fontSize:22,fontWeight:700,minWidth:30,textAlign:"center",color:"#aec6ff"}}>{count}</span>
      <button className="ea-btn" style={notchBtn(false)} onClick={()=>setCountSafe(count+1)}>+</button>
    </div>
    <SectionLabel>3 · Match Saturday for each weekend</SectionLabel>
    {Array.from({length:count}).map((_,i)=>(
      <div key={i} style={{display:"flex",alignItems:"center",gap:12,marginBottom:9}}>
        <span style={{color:"#7da6ff",fontSize:13,minWidth:64,fontFamily:FONT_LABEL,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em"}}>Week {i+1}</span>
        <input type="date" style={fieldStyle} value={dates[i]||""} onChange={e=>setDates(d=>d.map((x,j)=>j===i?e.target.value:x))}/>
      </div>
    ))}
    <button className="ea-btn" style={{...notchBtn(true),marginTop:18,width:"100%"}} disabled={busy} onClick={create}>{busy?"Creating…":"Create Season →"}</button>
  </TPanel>;
}

/* ══════════════ WEEKEND DETAIL (registration) ══════════════ */
function WeekendDetail({profile,eventId,onBack,onSignOut}){
  const isHost=profile.role==="host";
  const [ev,setEv]=useState(null),[loading,setLoading]=useState(true),[tick,setTick]=useState(0),[showDraft,setShowDraft]=useState(false);
  useEffect(()=>{
    (async()=>{setLoading(true);const {data:s}=await DB.seasonsActive();if(s){const {data:e}=await DB.eventsForSeason(s.id);setEv((e||[]).find(x=>x.id===eventId)||null);}setLoading(false);})();
  },[eventId]);
  if(loading)return <Shell><div className="page-wrap" style={{paddingTop:30}}><TPanel><p style={{margin:0,color:MUTE,fontFamily:FONT_LABEL}}>LOADING…</p></TPanel></div></Shell>;
  if(!ev)return <Shell><div className="page-wrap" style={{paddingTop:30}}><TPanel><p style={{margin:0,color:MUTE}}>Weekend not found.</p><button className="ea-btn" style={{...notchBtn(false),marginTop:12}} onClick={onBack}>‹ Back</button></TPanel></div></Shell>;
  if(showDraft)return <Draft profile={profile} ev={ev} onBack={()=>setShowDraft(false)} onSignOut={onSignOut}/>;
  const phase=computeAutoPhase(ev),b=phaseBadge(phase);
  return <Shell><div className="page-wrap" style={{paddingTop:30,paddingBottom:50}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
      <Brand/><button className="ea-btn" onClick={onSignOut} style={notchBtn(false)}>Sign out</button>
    </div>
    <button className="ea-btn" style={{...notchBtn(false),marginBottom:16}} onClick={onBack}>‹ Back to schedule</button>
    <TPanel style={{marginBottom:14}}>
      <Eyebrow>Weekend</Eyebrow>
      <TungstenHead word1={ev.weekend_label.split(" ")[0]} word2={ev.weekend_label.split(" ").slice(1).join(" ")}/>
      <p style={{color:MUTE,marginTop:10,fontFamily:FONT_MONO,fontSize:12,letterSpacing:"0.04em"}}>REG {fmt(ev.reg_opens)}–{fmt(ev.reg_closes)} · DRAFT {fmt(ev.draft_at)} · MATCHES {fmt(ev.matches_start)}–{fmt(ev.matches_end)}</p>
      <div style={{marginTop:12}}><span style={{padding:"5px 13px",fontSize:11,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:b.color,border:`1px solid ${b.color}66`,background:`${b.color}1a`,clipPath:notch(7),fontFamily:FONT_LABEL}}>{b.label}</span></div>
    </TPanel>
    {isHost && <div style={{marginBottom:14}}><button className="ea-btn" onClick={()=>setShowDraft(true)} style={{...notchBtn(true),padding:"12px 20px"}}>⚡ Open Draft</button></div>}
    {isHost?<HostRoster profile={profile} ev={ev} tick={tick}/>:<PlayerReg profile={profile} ev={ev} phase={phase} onChange={()=>setTick(t=>t+1)}/>}
  </div></Shell>;
}
function PlayerReg({profile,ev,phase,onChange}){
  const regOpen=phase==="registration_open";
  const [reg,setReg]=useState(undefined);
  async function load(){setReg(await DB.myReg(ev.id));}
  useEffect(()=>{load();},[ev.id]);
  if(reg===undefined)return <TPanel><p style={{margin:0,color:MUTE}}>…</p></TPanel>;
  const isIn=!!reg;
  if(!regOpen)return <TPanel><SectionLabel>Registration</SectionLabel><p style={{color:MUTE,fontSize:15,margin:0,fontFamily:FONT_LABEL}}>{isIn?"You're registered for this weekend. Registration is now closed.":"Registration for this weekend is closed."}</p></TPanel>;
  async function toggle(){if(isIn){await DB.unregister(ev.id);}else{await DB.register(profile.community_id,ev.id);}await load();onChange&&onChange();}
  async function setCap(v){await DB.setMyWantsCaptain(v);await load();onChange&&onChange();}
  return <TPanel>
    <SectionLabel>Your registration</SectionLabel>
    {isIn?<>
      <div style={okBox}>✓ You're in for this weekend.</div>
      <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",color:"#cfe0f0",fontSize:15,margin:"6px 0 16px",fontFamily:FONT_LABEL}}>
        <input type="checkbox" checked={!!reg.wantsCaptain} onChange={e=>setCap(e.target.checked)}/>Raise my hand to be a captain</label>
      <button className="ea-btn" style={{...notchBtn(false),width:"100%"}} onClick={toggle}>Drop out of this weekend</button>
    </>:<>
      <p style={{color:MUTE,fontSize:15,margin:"0 0 16px",fontFamily:FONT_LABEL}}>Available this weekend? Register to be in the draft pool.</p>
      <button className="ea-btn" style={{...notchBtn(true),width:"100%"}} onClick={toggle}>I'm in for this weekend →</button>
    </>}
  </TPanel>;
}
function HostRoster({profile,ev,tick}){
  const [regs,setRegs]=useState(null);
  useEffect(()=>{DB.regsForEvent(ev.id).then(setRegs);},[ev.id,tick]);
  if(!regs)return <TPanel><p style={{margin:0,color:MUTE}}>…</p></TPanel>;
  const captains=regs.filter(r=>r.wantsCaptain);
  const stat=(n,label)=>(<div style={{flex:1,minWidth:120,padding:"12px 16px",background:"rgba(61,123,255,0.06)",border:"1px solid rgba(61,123,255,0.2)",clipPath:notch(9)}}>
    <div style={{fontFamily:FONT_MONO,fontSize:28,fontWeight:700,color:"#aec6ff",lineHeight:1}}>{n}</div>
    <div style={{fontSize:11,letterSpacing:"0.12em",textTransform:"uppercase",color:"#7da6ff",fontFamily:FONT_LABEL,fontWeight:600,marginTop:5}}>{label}</div></div>);
  return <TPanel>
    <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>{stat(regs.length,"Registered")}{stat(captains.length,"Captain volunteers")}</div>
    <SectionLabel>Roster</SectionLabel>
    {regs.length?<div style={{display:"flex",flexDirection:"column",gap:8}}>
      {regs.map((r,i)=>(<div key={r.id||i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 14px",background:"rgba(255,255,255,0.025)",border:"1px solid rgba(120,150,220,0.16)",clipPath:notch(9)}}>
        <span style={{fontFamily:FONT_LABEL,fontWeight:600,fontSize:16,color:"#dce6ff",letterSpacing:"0.02em"}}>{r.name}</span>
        {r.wantsCaptain?<span style={{padding:"5px 13px",fontSize:11,fontWeight:700,letterSpacing:"0.12em",textTransform:"uppercase",color:"#f5c453",border:"1px solid #f5c45366",background:"#f5c4531a",clipPath:notch(7),fontFamily:FONT_LABEL}}>★ Captain volunteer</span>:<span style={{fontFamily:FONT_MONO,color:"rgba(200,215,255,0.4)",fontSize:12}}>player</span>}
      </div>))}
    </div>:<p style={{color:MUTE,fontSize:15,margin:0,fontFamily:FONT_LABEL}}>No one has registered yet.</p>}
  </TPanel>;
}

/* ══════════════ LEADERBOARD (season standings + match logging + AI import) ══════════════ */
function Leaderboard({profile,onBack,onSignOut}){
  const isHost=profile.role==="host";
  const [rows,setRows]=useState(null);     // raw match rows for the season
  const [events,setEvents]=useState([]);
  const [openName,setOpenName]=useState(null);
  const [nameMap,setNameMap]=useState({});

  async function load(){
    const {data:s}=await DB.seasonsActive();
    if(!s){setRows([]);setEvents([]);return;}
    const {data:e}=await DB.eventsForSeason(s.id);
    setEvents(e||[]);
    setRows(await DB.resultsForSeason(s.id));
    setNameMap(await DB.getNameMap(profile.community_id));
  }
  useEffect(()=>{load();},[]);

  if(rows===null)return <Shell><div className="page-wrap" style={{paddingTop:40}}><TPanel><p style={{margin:0,color:MUTE}}>LOADING…</p></TPanel></div></Shell>;

  const board=seasonBoardFrom(rows);
  const unverified=rows.filter(r=>r.unverified).length;
  const liveId=(()=>{
    if(!events.length)return null;
    const byPhase=ph=>events.find(ev=>computeAutoPhase(ev)===ph);
    const hit=byPhase("matches_live")||byPhase("drafting");
    if(hit)return hit.id;
    const open=events.filter(ev=>computeAutoPhase(ev)!=="settled");
    return open.length?open[0].id:events[0].id;
  })();

  const medal=["#ffd75e","#cdd7e6","#e0985a"];
  return <Shell><div className="page-wrap" style={{paddingTop:30,paddingBottom:50}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
      <Brand/>
      <button className="ea-btn" onClick={onSignOut} style={notchBtn(false)}>Sign out</button>
    </div>
    <button className="ea-btn" onClick={onBack} style={{...notchBtn(false),marginBottom:16}}>‹ Back to schedule</button>
    <Eyebrow>Season Standings</Eyebrow>
    <TungstenHead word1="Leader" word2="board"/>
    <p style={{color:MUTE,fontSize:14,margin:"6px 0 18px",fontFamily:FONT_LABEL}}>Ranked by average points per match. Win = 100 · ACS÷4 · kills + ½ assists.{isHost&&" Tap a player to log a match."}</p>

    {isHost && <ImportPanel profile={profile} events={events} liveId={liveId} nameMap={nameMap} setNameMap={setNameMap} onDone={load}/>}

    {isHost && unverified>0 && <div style={{marginBottom:14,padding:"9px 13px",background:"rgba(245,196,83,0.08)",border:"1px solid rgba(245,196,83,0.4)",color:"#f5c453",fontFamily:FONT_LABEL,fontSize:13,clipPath:notch(8)}}>⚑ {unverified} AI-read match{unverified===1?"":"es"} awaiting confirmation — tap a player to review.</div>}

    <div style={{display:"grid",gridTemplateColumns:"38px 1fr 56px 56px 64px 70px",gap:10,padding:"6px 16px",fontSize:10,textTransform:"uppercase",letterSpacing:"0.12em",color:"rgba(200,215,255,0.4)",fontFamily:FONT_LABEL}}>
      <span>#</span><span>Player</span><span style={{textAlign:"center"}}>K</span><span style={{textAlign:"center"}}>A</span><span style={{textAlign:"center"}}>ACS</span><span style={{textAlign:"center"}}>AVG</span>
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {board.length===0 && <div style={{padding:"14px 16px",background:"rgba(61,123,255,0.06)",border:"1px solid rgba(61,123,255,0.25)",color:"rgba(200,215,255,0.6)",clipPath:notch(12),fontFamily:FONT_LABEL}}>{isHost?"No match stats yet. Upload a scoreboard above, or tap a player to log one by hand.":"No match stats logged yet. The board fills in as weekends are played."}</div>}
      {board.map((p,i)=>{
        const top=i<3;
        return <React.Fragment key={p.name}>
          <div onClick={isHost?()=>setOpenName(openName===p.name?null:p.name):undefined}
            style={{display:"grid",gridTemplateColumns:"38px 1fr 56px 56px 64px 70px",alignItems:"center",gap:10,padding:"13px 16px",cursor:isHost?"pointer":"default",
              background:top?`linear-gradient(90deg,${medal[i]}14,rgba(10,15,28,0.5))`:"rgba(255,255,255,0.025)",
              border:`1px solid ${top?medal[i]+"55":"rgba(120,150,220,0.14)"}`,clipPath:notch(12)}}>
            <span style={{fontFamily:FONT_MONO,fontSize:18,fontWeight:700,color:top?medal[i]:"rgba(200,215,255,0.5)",textShadow:top?`0 0 10px ${medal[i]}88`:"none"}}>{i+1}</span>
            <span style={{fontFamily:FONT_LABEL,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.02em",color:"#ecf3ff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}{p.unverified>0&&<span style={{marginLeft:8,color:"#f5c453",fontSize:11}} title="has unverified matches">⚑</span>}</span>
            <span style={{fontFamily:FONT_MONO,textAlign:"center",color:"#9af5c2"}}>{p.k}</span>
            <span style={{fontFamily:FONT_MONO,textAlign:"center",color:"rgba(200,215,255,0.7)"}}>{p.a}</span>
            <span style={{fontFamily:FONT_MONO,textAlign:"center",color:"#5b8dff",textShadow:"0 0 12px rgba(61,123,255,0.5)"}}>{p.acs}</span>
            <span style={{fontFamily:FONT_MONO,textAlign:"center",fontWeight:700,fontSize:17,color:"#fff"}}>{p.avg.toFixed(0)}</span>
          </div>
          {isHost&&openName===p.name && <LogPanel profile={profile} name={p.name} events={events} rows={rows.filter(r=>r.name===p.name)} liveId={liveId} onChange={load}/>}
        </React.Fragment>;
      })}
    </div>
  </div></Shell>;
}

function LogPanel({profile,name,events,rows,liveId,onChange}){
  const [k,setK]=useState(""),[a,setA]=useState(""),[acs,setAcs]=useState(""),[won,setWon]=useState(false);
  const [evId,setEvId]=useState(liveId??(events[0]?.id));
  const fld=(label,val,set)=>(<div style={{display:"flex",flexDirection:"column",gap:3}}>
    <span style={{fontSize:9,textTransform:"uppercase",letterSpacing:"0.1em",color:"rgba(200,215,255,0.4)",fontFamily:FONT_LABEL}}>{label}</span>
    <input value={val} inputMode="numeric" onChange={e=>set(e.target.value.replace(/[^0-9]/g,""))} style={{...fieldStyle,width:60,padding:"7px 8px",textAlign:"center"}} placeholder="0"/>
  </div>);
  async function add(){
    if(k===""&&a===""&&acs==="")return;
    const uid=await DB.userIdByName(profile.community_id,name);
    if(!uid)return;
    await DB.addResult(profile.community_id,evId,uid,{k,a,acs,won,unverified:false});
    setK("");setA("");setAcs("");setWon(false);onChange&&onChange();
  }
  return <div style={{padding:"14px 16px",background:"rgba(7,12,22,0.7)",border:"1px solid rgba(61,123,255,0.25)",clipPath:notch(12)}}>
    <div style={{display:"flex",alignItems:"flex-end",gap:10,flexWrap:"wrap",marginBottom:12}}>
      <div style={{display:"flex",flexDirection:"column",gap:3}}>
        <span style={{fontSize:9,textTransform:"uppercase",letterSpacing:"0.1em",color:"rgba(200,215,255,0.4)",fontFamily:FONT_LABEL}}>Weekend</span>
        <select value={evId} onChange={e=>setEvId(e.target.value)} style={{...fieldStyle,padding:"7px 8px"}}>{events.map(ev=><option key={ev.id} value={ev.id}>{ev.weekend_label}</option>)}</select>
      </div>
      {fld("K",k,setK)}{fld("A",a,setA)}{fld("ACS",acs,setAcs)}
      <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",color:"#cfe0f0",fontSize:13,fontFamily:FONT_LABEL,paddingBottom:6}}>
        <input type="checkbox" checked={won} onChange={e=>setWon(e.target.checked)}/>Won</label>
      <button className="ea-btn" onClick={add} style={{padding:"8px 14px",fontSize:12,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:FONT_LABEL,background:"rgba(61,220,132,0.18)",border:"1px solid #3ddc8488",color:"#9af5c2",cursor:"pointer",clipPath:notch(8)}}>+ Add match</button>
    </div>
    {rows.length>0 && <div>
      <div style={{fontSize:10,textTransform:"uppercase",letterSpacing:"0.12em",color:"rgba(200,215,255,0.4)",marginBottom:5,fontFamily:FONT_LABEL}}>Logged matches</div>
      <div style={{display:"flex",flexDirection:"column",gap:4}}>
        {rows.map(r=>(<div key={r.id} style={{display:"flex",alignItems:"center",gap:10,fontSize:12,padding:"6px 10px",background:r.unverified?"rgba(245,196,83,0.07)":"rgba(255,255,255,0.03)",fontFamily:FONT_MONO,color:"rgba(220,230,255,0.75)",borderLeft:r.unverified?"2px solid #f5c453":"none"}}>
          <span style={{color:"rgba(200,215,255,0.4)",minWidth:60}}>{r.weekend}</span>
          <span style={{color:r.won?"#3ddc84":"rgba(255,138,148,0.8)"}}>{r.won?"WON":"lost"}</span>
          <span style={{color:"#9af5c2"}}>{r.k}K</span><span>{r.a}A</span><span style={{color:"#5b8dff"}}>{r.acs} ACS</span>
          <span style={{marginLeft:"auto",color:"#fff",fontWeight:700}}>{Math.round(matchPoints(r))} pts</span>
          {r.unverified&&<button className="ea-btn" onClick={async()=>{await DB.verifyResult(r.id);onChange&&onChange();}} style={{color:"#f5c453",border:"1px solid rgba(245,196,83,0.5)",padding:"1px 7px",cursor:"pointer",background:"none",fontSize:11}}>⚑ confirm</button>}
          <button className="ea-btn" onClick={async()=>{await DB.removeResult(r.id);onChange&&onChange();}} style={{color:"#ff8a94",border:"1px solid rgba(255,70,85,0.4)",padding:"1px 7px",cursor:"pointer",background:"none"}}>✕</button>
        </div>))}
      </div>
    </div>}
  </div>;
}

function ImportPanel({profile,events,liveId,nameMap,setNameMap,onDone}){
  const [stage,setStage]=useState("idle"); // idle | reading | matching | review
  const [evId,setEvId]=useState(liveId??(events[0]?.id));
  const [ai,setAi]=useState(null);
  const [unresolved,setUnresolved]=useState([]);
  const [queue,setQueue]=useState([]);
  const [err,setErr]=useState("");
  const [regsForPick,setRegsForPick]=useState([]);
  const fileRef=useRef(null);

  async function onFile(e){
    const f=e.target.files?.[0]; if(!f)return;
    setErr("");setStage("reading");
    try{
      const dataUrl=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result));r.onerror=rej;r.readAsDataURL(f);});
      const result=await aiReadScoreboard(dataUrl);
      const regs=await DB.regsForEvent(evId);
      const un=[];
      result.rows.forEach(r=>{r.resolved=resolveName(r.scoreName,regs,nameMap);if(!r.resolved)un.push(r);});
      setAi(result);setUnresolved(un);setRegsForPick(regs);
      setStage(un.length?"matching":"review");
    }catch(ex){ setErr("Couldn't read that screenshot. Try a clearer full-scoreboard image."); setStage("idle"); }
  }

  async function confirmNames(){
    const map={...nameMap};
    unresolved.forEach(u=>{ if(u._pick){map[u.scoreName]=u._pick; u.resolved=u._pick;} });
    setNameMap(map); await DB.setNameMap(profile.community_id,map);
    setStage("review");
  }

  function pushQueue(){
    const rows=ai.rows.filter(r=>r.resolved).map(r=>({name:r.resolved,k:r.k,a:r.a,acs:r.acs,won:r.team===ai.winningTeam}));
    setQueue(q=>[...q,{event:evId,map:ai.map,scoreA:ai.scoreA,scoreB:ai.scoreB,rows}]);
    setAi(null);
  }
  async function commitAll(extra){
    const all=extra?[...queue,extra]:queue;
    for(const q of all){
      for(const r of q.rows){
        const uid=await DB.userIdByName(profile.community_id,r.name);
        if(uid)await DB.addResult(profile.community_id,q.event,uid,{k:r.k,a:r.a,acs:r.acs,won:r.won,unverified:true});
      }
    }
    setQueue([]);setAi(null);setStage("idle");onDone&&onDone();
  }

  const wrap=(kids)=>(<TPanel style={{marginBottom:16}}>{kids}</TPanel>);

  if(stage==="reading")return wrap(<div style={{display:"flex",alignItems:"center",gap:12}}>
    <div style={{fontFamily:FONT_MONO,color:CYAN,fontSize:14}}>◢ Reading scoreboard…</div>
    <span style={{color:MUTE,fontSize:12,fontFamily:FONT_LABEL}}>map · round score · every player's K / A / ACS</span></div>);

  if(stage==="matching")return wrap(<div>
    <p style={{fontSize:11,letterSpacing:"0.12em",textTransform:"uppercase",color:"#f5c453",fontFamily:FONT_LABEL,fontWeight:600,margin:"0 0 10px"}}>Who are these players?</p>
    <p style={{color:MUTE,fontSize:12,margin:"0 0 12px",fontFamily:FONT_LABEL}}>A few scoreboard names didn't match your roster. Match them once and I'll remember next time.</p>
    {unresolved.map((u,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
      <span style={{fontFamily:FONT_MONO,minWidth:120,color:"#dce6ff"}}>{u.scoreName}</span><span style={{color:"rgba(200,215,255,0.4)"}}>→</span>
      <select defaultValue="" onChange={e=>u._pick=e.target.value} style={{...fieldStyle,maxWidth:160}}>
        <option value="">— skip —</option>
        {regsForPick.map(p=><option key={p.id||p.name} value={p.name}>{p.name}</option>)}
      </select>
    </div>))}
    <button className="ea-btn" onClick={confirmNames} style={{...notchBtn(true),marginTop:8}}>Continue to review</button>
  </div>);

  if(stage==="review"&&ai)return wrap(<div>
    <p style={{fontSize:11,letterSpacing:"0.12em",textTransform:"uppercase",color:"#7da6ff",fontFamily:FONT_LABEL,fontWeight:600,margin:"0 0 10px"}}>Review · {events.find(e=>e.id===evId)?.weekend_label}</p>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
      <span style={{fontFamily:FONT_MONO,color:"#9fb8e8",fontSize:13}}>MAP</span>
      <span style={{fontFamily:FONT_LABEL,fontWeight:700,color:"#ecf3ff",textTransform:"uppercase",letterSpacing:"0.04em"}}>{ai.map}</span>
      <span style={{width:1,height:16,background:"rgba(120,150,220,0.3)"}}/>
      <span style={{fontFamily:FONT_MONO,color:"#9fb8e8",fontSize:13}}>SCORE</span>
      <span style={{fontFamily:FONT_MONO,color:"#3ddc84",fontWeight:700,fontSize:16}}>{ai.scoreA}</span>
      <span style={{color:"rgba(200,215,255,0.4)"}}>–</span>
      <span style={{fontFamily:FONT_MONO,color:"#ff8a94",fontWeight:700,fontSize:16}}>{ai.scoreB}</span>
      <span style={{color:MUTE,fontSize:12,marginLeft:6,fontFamily:FONT_LABEL}}>Team {ai.winningTeam} wins</span>
    </div>
    {ai.rows.some(r=>lowConf(r.conf?.k)||lowConf(r.conf?.a)||lowConf(r.conf?.acs))
      ? <div style={{marginBottom:10,padding:"7px 11px",background:"rgba(245,196,83,0.08)",border:"1px solid rgba(245,196,83,0.4)",color:"#f5c453",fontSize:12,fontFamily:FONT_LABEL,clipPath:notch(8)}}>⚑ Amber fields are ones I wasn't fully sure about — give them a glance.</div>
      : <p style={{margin:"0 0 10px",color:"#86e6b0",fontSize:12,fontFamily:FONT_LABEL}}>✓ Clean read — all fields high-confidence.</p>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 56px 56px 56px 54px",gap:8,padding:"0 2px 6px",fontSize:10,textTransform:"uppercase",letterSpacing:"0.1em",color:"rgba(200,215,255,0.4)",fontFamily:FONT_LABEL}}>
      <span>Player</span><span style={{textAlign:"center"}}>K</span><span style={{textAlign:"center"}}>A</span><span style={{textAlign:"center"}}>ACS</span><span style={{textAlign:"center"}}>Won</span></div>
    {ai.rows.map((r,i)=>{
      const won=r.team===ai.winningTeam;
      const box=(val,low,set)=>(<input defaultValue={val} inputMode="numeric" onChange={e=>{const v=e.target.value.replace(/[^0-9]/g,"");e.target.value=v;set(+v||0);}} style={{...fieldStyle,width:56,padding:"6px 7px",textAlign:"center",...(low?{borderColor:"#f5c453",background:"rgba(245,196,83,0.12)",boxShadow:"0 0 0 1px rgba(245,196,83,0.4)"}:{})}}/>);
      return <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 56px 56px 56px 54px",gap:8,alignItems:"center",padding:"5px 2px"}}>
        {r.resolved?<span style={{fontFamily:FONT_LABEL,fontWeight:700,color:"#ecf3ff",textTransform:"uppercase",fontSize:13,letterSpacing:"0.02em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.resolved}</span>:<span style={{fontFamily:FONT_MONO,color:"rgba(255,138,148,0.7)",fontSize:12}}>{r.scoreName} · skipped</span>}
        {box(r.k,lowConf(r.conf?.k),v=>r.k=v)}
        {box(r.a,lowConf(r.conf?.a),v=>r.a=v)}
        {box(r.acs,lowConf(r.conf?.acs),v=>r.acs=v)}
        <span style={{textAlign:"center",color:won?"#3ddc84":"rgba(255,138,148,0.7)",fontFamily:FONT_LABEL,fontWeight:700,fontSize:12}}>{won?"W":"L"}</span>
      </div>;
    })}
    <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
      <button className="ea-btn" onClick={()=>{pushQueue();setStage("idle");}} style={notchBtn(true)}>＋ Add another match</button>
      <button className="ea-btn" onClick={()=>{const rows=ai.rows.filter(r=>r.resolved).map(r=>({name:r.resolved,k:r.k,a:r.a,acs:r.acs,won:r.team===ai.winningTeam}));commitAll({event:evId,map:ai.map,scoreA:ai.scoreA,scoreB:ai.scoreB,rows});}} style={{...notchBtn(true),background:"rgba(61,220,132,0.18)",borderColor:"#3ddc8488",color:"#9af5c2"}}>✓ Save {queue.length?("all "+(queue.length+1)):"match"}</button>
    </div>
  </div>);

  // idle
  return wrap(<div>
    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <span style={{fontSize:11,letterSpacing:"0.12em",textTransform:"uppercase",color:"#7da6ff",fontFamily:FONT_LABEL,fontWeight:600}}>Auto-import results</span>
      <select value={evId} onChange={e=>setEvId(e.target.value)} style={{...fieldStyle,maxWidth:170}}>{events.map(ev=><option key={ev.id} value={ev.id}>{ev.weekend_label}{ev.id===liveId?" · live":""}</option>)}</select>
      <button className="ea-btn" onClick={()=>fileRef.current?.click()} style={notchBtn(true)}>⤓ Upload scoreboard</button>
      <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={onFile}/>
    </div>
    <p style={{color:MUTE,fontSize:12,margin:"8px 0 0",fontFamily:FONT_LABEL}}>Defaults to the live weekend. Upload a full scoreboard — I read every player, the map and the round score, then you eyeball anything I'm unsure about before it saves.{queue.length>0&&` ${queue.length} match${queue.length>1?"es":""} queued.`}</p>
    {err&&<p style={{color:"#ff8a94",fontSize:12,margin:"8px 0 0",fontFamily:FONT_LABEL}}>{err}</p>}
    {queue.length>0 && <div style={{marginTop:12}}>
      <p style={{fontSize:10,textTransform:"uppercase",letterSpacing:"0.12em",color:"rgba(200,215,255,0.4)",margin:"0 0 7px",fontFamily:FONT_LABEL}}>Queued to save</p>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>{queue.map((q,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 11px",background:"rgba(0,229,255,0.06)",border:"1px solid rgba(0,229,255,0.25)",fontSize:12,fontFamily:FONT_MONO,color:"#bfe9f5",clipPath:notch(8)}}>
        <span style={{color:"#7fdff0"}}>{events.find(e=>e.id===q.event)?.weekend_label}</span><span>{q.map} {q.scoreA}–{q.scoreB}</span><span style={{color:"rgba(200,215,255,0.5)"}}>{q.rows.length}p</span>
        <button className="ea-btn" onClick={()=>setQueue(qq=>qq.filter((_,j)=>j!==i))} style={{marginLeft:4,color:"#ff8a94",border:"1px solid rgba(255,70,85,0.4)",padding:"0 6px",cursor:"pointer",background:"none"}}>✕</button>
      </div>))}</div>
      <button className="ea-btn" onClick={()=>commitAll()} style={{...notchBtn(true),marginTop:10,background:"rgba(61,220,132,0.18)",borderColor:"#3ddc8488",color:"#9af5c2"}}>✓ Save all {queue.length} queued</button>
    </div>}
  </div>);
}

/* ══════════════ DRAFT (Stage 2 — live realtime auction) ══════════════ */
const SPIN_MS = 2600, REVEAL_MS = 1100;
const emptySlots = (t)=> Math.max(DRAFT_SLOTS - t.roster.length, 0);

function Draft({profile,ev,onBack,onSignOut}){
  const isHost = profile.role==="host";
  const myId = profile.id;
  const [players,setPlayers]=useState(null);   // registered pool (with ranks)
  const [st,setSt]=useState(null);              // live draft_state
  const [busy,setBusy]=useState(false);
  const [spinView,setSpinView]=useState(null);  // local spin animation overlay
  const stRef = useRef(null);

  // load static players once, plus current live state, then subscribe
  useEffect(()=>{
    let unsub=()=>{};
    (async()=>{
      setPlayers(await DB.draftPlayers(ev.id));
      const existing = await DB.getDraftState(ev.id);
      if(existing){ setSt(existing); stRef.current=existing; }
      unsub = DB.subscribeDraft(ev.id,(state)=>{ setSt(state); stRef.current=state; maybeSpin(state); });
    })();
    return ()=>unsub();
  },[ev.id]);

  // write helper: host (or captain bidding) pushes new state to everyone
  async function push(next){ stRef.current=next; setSt(next); await DB.setDraftState(profile.community_id, ev.id, next); }

  // trigger local spin overlay when a new spin appears
  function maybeSpin(state){
    if(state?.spin && (!spinView || spinView.startTs!==state.spin.startTs)){
      setSpinView(state.spin);
      setTimeout(()=>setSpinView(null), SPIN_MS+REVEAL_MS);
    }
  }

  if(players===null) return <Shell><div className="page-wrap" style={{paddingTop:40}}><TPanel><p style={{margin:0,color:MUTE,fontFamily:FONT_LABEL}}>LOADING DRAFT…</p></TPanel></div></Shell>;

  const captains = players.filter(p=>p.isCaptain);
  const started = !!st?.started;

  // ── START DRAFT: create teams from captains, seed live state ──
  async function startDraft(){
    if(busy) return; setBusy(true);
    const teams=[];
    for(const c of captains){
      const teamName = c.name ? c.name : `${c.name||c.id}'s Team`;
      const res = await DB.createTeamForCaptain(profile.community_id, ev.id, c.id, c.name ? c.name+"'s Squad" : (captains.indexOf(c)===0?"CRIMSON PULSE":"NEON SYNDICATE"));
      const t = res?.data || res; // real returns {data}, mock returns team
      teams.push({ id:t.id, name:t.name, captainId:c.id, captain:c.name, budget:START_BUDGET, roster:[], prices:{} });
    }
    const poolPlayers = players.filter(p=>!p.isCaptain).map(p=>({ id:p.id, name:p.name, rank:p.rank, status:"pool" }));
    const next = { started:true, teams, players:poolPlayers, block:null, bidHistory:[], spin:null, log:["Draft started — spin to nominate the first player"], recentSales:[] };
    await push(next); setBusy(false);
  }

  // ── NOMINATE (fate wheel) ──
  async function spinNominate(){
    const s = structuredClone(stRef.current); if(!s||s.block) return;
    const pool = s.players.filter(p=>p.status==="pool");
    if(!pool.length) return;
    const winner = pool[Math.floor(Math.random()*pool.length)];
    winner.status="block";
    s.block = { playerId:winner.id, startingBid:RANKS[winner.rank]?.bid||0, currentBid:RANKS[winner.rank]?.bid||0, leaderId:null, ts:Date.now() };
    s.spin = { playerId:winner.id, pool:pool.map(p=>p.id), startTs:Date.now() };
    s.bidHistory=[];
    s.log=[`Fate chose ${winner.name} — opening at ${fmtMoney(s.block.startingBid)}`,...s.log].slice(0,8);
    await push(s);
  }

  // ── BID ──
  async function placeBid(teamId){
    const s = structuredClone(stRef.current); const b=s.block; if(!b||b.leaderId===teamId) return;
    const team = s.teams.find(t=>t.id===teamId); if(!team||emptySlots(team)===0) return;
    const availablePool = s.players.filter(p=>p.status==="pool");
    const req = requiredBid(b);
    if(maxAllowedBid(team, availablePool) < req) return;
    b.currentBid=req; b.leaderId=teamId; b.ts=Date.now();
    s.bidHistory=[{teamId,amount:req,ts:Date.now()},...s.bidHistory].slice(0,12);
    const p=s.players.find(x=>x.id===b.playerId);
    s.log=[`${team.name} bids ${fmtMoney(req)} on ${p?.name}`,...s.log].slice(0,8);
    await push(s);
  }

  // ── SELL ──
  async function sell(){
    const s = structuredClone(stRef.current); const b=s.block; if(!b||!b.leaderId) return;
    const team=s.teams.find(t=>t.id===b.leaderId), p=s.players.find(x=>x.id===b.playerId);
    if(!team||!p) return;
    team.budget-=b.currentBid; team.roster.push(p.id); team.prices=team.prices||{}; team.prices[p.id]=b.currentBid;
    p.status="sold"; p.soldTo=team.id; p.soldPrice=b.currentBid;
    s.recentSales=[{playerId:p.id,name:p.name,teamId:team.id,price:b.currentBid,ts:Date.now()},...(s.recentSales||[])].slice(0,10);
    s.log=[`SOLD — ${p.name} → ${team.name} for ${fmtMoney(b.currentBid)}`,...s.log].slice(0,8);
    s.block=null; s.bidHistory=[];
    await push(s);
    // persist this team's roster immediately
    await DB.commitDraftResults(profile.community_id, ev.id, [team]);
  }

  // ── PASS ──
  async function passPlayer(){
    const s = structuredClone(stRef.current); const b=s.block; if(!b) return;
    const p=s.players.find(x=>x.id===b.playerId); if(p) p.status="pool";
    s.log=[`${p?.name} passed — back to the pool`,...s.log].slice(0,8);
    s.block=null; s.bidHistory=[]; await push(s);
  }

  const myTeam = st?.teams?.find(t=>t.captainId===myId) || null;
  const block = st?.block || null;
  const blockPlayer = block ? st.players.find(p=>p.id===block.playerId) : null;
  const leaderTeam = block?.leaderId ? st.teams.find(t=>t.id===block.leaderId) : null;
  const poolLeft = st?.players?.filter(p=>p.status==="pool").length || 0;
  const allDone = started && poolLeft===0 && !block;

  return <Shell><div className="page-wrap" style={{paddingTop:30,paddingBottom:60}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
      <Brand/><button className="ea-btn" onClick={onSignOut} style={notchBtn(false)}>Sign out</button>
    </div>
    <button className="ea-btn" style={{...notchBtn(false),marginBottom:16}} onClick={onBack}>‹ Back to weekend</button>
    <Eyebrow>Auction Draft</Eyebrow>
    <TungstenHead word1="Auction" word2="Block"/>
    <p style={{color:MUTE,fontSize:14,margin:"6px 0 18px",fontFamily:FONT_LABEL}}>{ev.weekend_label} · {captains.length} captains · {fmtMoney(START_BUDGET)} each · {DRAFT_SLOTS} slots.</p>

    {/* START */}
    {!started && <TPanel style={{marginBottom:16}}>
      <p style={{margin:"0 0 12px",color:MUTE,fontFamily:FONT_LABEL}}>Ready with {captains.length} captains and {players.filter(p=>!p.isCaptain).length} players in the pool.{captains.length<2?" You need at least 2 captains to draft.":""}</p>
      {isHost && captains.length>=2 && <button className="ea-btn" disabled={busy} onClick={startDraft} style={{...notchBtn(true),padding:"12px 22px"}}>{busy?"Starting…":"⚡ Start the draft"}</button>}
      {!isHost && <p style={{margin:0,color:MUTE,fontFamily:FONT_LABEL,fontSize:13}}>Waiting for the host to start the draft…</p>}
    </TPanel>}

    {/* SPIN OVERLAY */}
    {spinView && blockPlayer && <div style={{position:"fixed",inset:0,zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(4,7,15,0.85)",backdropFilter:"blur(6px)"}}>
      <div style={{textAlign:"center",animation:"voltpop 0.5s ease"}}>
        <div style={{fontFamily:FONT_LABEL,letterSpacing:"0.3em",textTransform:"uppercase",color:CYAN,fontSize:13,marginBottom:14}}>Fate selects</div>
        <div style={{fontFamily:FONT_HEAD,fontSize:"clamp(3rem,9vw,6rem)",fontWeight:700,textTransform:"uppercase",color:"#fff",textShadow:"0 0 40px rgba(61,123,255,0.7)"}}>{blockPlayer.name}</div>
        <div style={{fontFamily:FONT_MONO,fontSize:18,marginTop:10,color:RANKS[blockPlayer.rank]?.c}}>{blockPlayer.rank} · opens {fmtMoney(RANKS[blockPlayer.rank]?.bid)}</div>
      </div>
    </div>}

    {started && <>
      {/* LIVE BLOCK */}
      {block && blockPlayer ? <div style={{marginBottom:18,padding:"22px 20px",background:"rgba(61,123,255,0.06)",border:"1px solid rgba(61,123,255,0.35)",clipPath:notch(14)}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:14}}>
          <div>
            <div style={{fontSize:11,letterSpacing:"0.2em",textTransform:"uppercase",color:CYAN,fontFamily:FONT_LABEL}}>On the block</div>
            <div style={{fontFamily:FONT_HEAD,fontSize:"clamp(2rem,5vw,3rem)",fontWeight:700,textTransform:"uppercase",color:"#fff"}}>{blockPlayer.name}</div>
            <div style={{fontFamily:FONT_MONO,fontSize:13,color:RANKS[blockPlayer.rank]?.c}}>{blockPlayer.rank}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,letterSpacing:"0.15em",textTransform:"uppercase",color:"rgba(200,215,255,0.5)",fontFamily:FONT_LABEL}}>{block.leaderId?"Top bid":"Opening"}</div>
            <div style={{fontFamily:FONT_MONO,fontSize:"clamp(2rem,5vw,3rem)",fontWeight:700,color:"#5b8dff",textShadow:"0 0 18px rgba(61,123,255,0.6)"}}>{fmtMoney(block.currentBid)}</div>
            {leaderTeam && <div style={{fontFamily:FONT_LABEL,fontSize:13,color:"#9af5c2"}}>{leaderTeam.name} leads</div>}
          </div>
        </div>

        {/* captain's own bid button */}
        {myTeam && (()=>{
          const availablePool = st.players.filter(p=>p.status==="pool");
          const req = requiredBid(block);
          const canBid = block.leaderId!==myTeam.id && emptySlots(myTeam)>0 && maxAllowedBid(myTeam,availablePool)>=req;
          return <button className="ea-btn" disabled={!canBid} onClick={()=>placeBid(myTeam.id)} style={{...notchBtn(true),width:"100%",marginTop:16,padding:"16px",fontSize:18,
            background:canBid?"linear-gradient(90deg,#2d6bff,#3d7bff)":"rgba(255,255,255,0.05)",color:canBid?"#fff":"rgba(236,243,255,0.3)",cursor:canBid?"pointer":"not-allowed"}}>
            {block.leaderId===myTeam.id?"You're leading":canBid?`Bid ${fmtMoney(req)}`:"Can't bid"}</button>;
        })()}

        {/* host controls */}
        {isHost && <div style={{display:"flex",gap:10,marginTop:12,flexWrap:"wrap"}}>
          <button className="ea-btn" disabled={!block.leaderId} onClick={sell} style={{...notchBtn(true),flex:1,padding:"14px",fontSize:16,background:block.leaderId?"linear-gradient(90deg,#1fbf75,#3ddc84)":"rgba(255,255,255,0.05)",color:block.leaderId?"#062b18":"rgba(236,243,255,0.25)",cursor:block.leaderId?"pointer":"not-allowed"}}>SOLD</button>
          <button className="ea-btn" onClick={passPlayer} style={{...notchBtn(false),padding:"14px 18px"}}>Pass</button>
        </div>}

        {/* host can also bid on behalf of any team (table) */}
        {isHost && <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
          {st.teams.map(t=>{
            const availablePool = st.players.filter(p=>p.status==="pool");
            const req=requiredBid(block);
            const canBid = block.leaderId!==t.id && emptySlots(t)>0 && maxAllowedBid(t,availablePool)>=req;
            return <button key={t.id} className="ea-btn" disabled={!canBid} onClick={()=>placeBid(t.id)} style={{...notchBtn(false),fontSize:12,opacity:canBid?1:0.4}}>{t.name} +{fmtMoney(req)}</button>;
          })}
        </div>}
      </div>
      : <div style={{marginBottom:18,textAlign:"center"}}>
          {isHost && poolLeft>0 && <button className="ea-btn" onClick={spinNominate} style={{...notchBtn(true),padding:"16px 30px",fontSize:18}}>🎯 Spin to nominate</button>}
          {allDone && <TPanel><p style={{margin:0,color:"#9af5c2",fontFamily:FONT_LABEL,fontSize:15}}>✓ Draft complete — every player has been sold. Rosters are saved.</p></TPanel>}
          {!isHost && poolLeft>0 && <p style={{color:MUTE,fontFamily:FONT_LABEL}}>Waiting for the host to nominate the next player…</p>}
        </div>}

      {/* TEAMS */}
      <SectionLabel>Teams</SectionLabel>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))",gap:10,margin:"8px 0 24px"}}>
        {st.teams.map(t=>{
          const mine = t.captainId===myId;
          return <div key={t.id} style={{padding:"14px 16px",background:mine?"rgba(61,123,255,0.08)":"rgba(255,255,255,0.025)",border:`1px solid ${mine?"rgba(61,123,255,0.5)":"rgba(120,150,220,0.18)"}`,clipPath:notch(10)}}>
            <div style={{fontFamily:FONT_LABEL,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.04em",color:"#ecf3ff"}}>{t.name}{mine&&<span style={{color:CYAN,fontSize:11,marginLeft:6}}>YOU</span>}</div>
            <div style={{fontFamily:FONT_MONO,fontSize:12,color:"rgba(200,215,255,0.5)",marginTop:3}}>Capt. {t.captain}</div>
            <div style={{fontFamily:FONT_MONO,fontSize:20,fontWeight:700,color:"#5b8dff",marginTop:6}}>{fmtMoney(t.budget)}</div>
            <div style={{fontSize:11,letterSpacing:"0.1em",textTransform:"uppercase",color:"rgba(200,215,255,0.4)",fontFamily:FONT_LABEL,marginTop:2}}>{t.roster.length}/{DRAFT_SLOTS} slots</div>
            {t.roster.length>0 && <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:3}}>
              {t.roster.map(pid=>{const pl=st.players.find(p=>p.id===pid);return <div key={pid} style={{fontFamily:FONT_MONO,fontSize:11,color:"rgba(220,230,255,0.7)",display:"flex",justifyContent:"space-between"}}><span>{pl?.name}</span><span style={{color:RANKS[pl?.rank]?.c}}>{fmtMoney(t.prices?.[pid])}</span></div>;})}
            </div>}
          </div>;
        })}
      </div>

      {/* POOL + FEED */}
      <div style={{display:"grid",gridTemplateColumns:"1fr",gap:18}}>
        <div>
          <SectionLabel>Player Pool · {poolLeft} left</SectionLabel>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:8}}>
            {st.players.filter(p=>p.status==="pool").map(p=>{const r=RANKS[p.rank];return <div key={p.id} style={{padding:"8px 12px",background:"rgba(255,255,255,0.03)",border:`1px solid ${r?r.c+"44":"rgba(120,150,220,0.16)"}`,clipPath:notch(7)}}>
              <span style={{fontFamily:FONT_LABEL,fontWeight:700,color:"#dce6ff",fontSize:14}}>{p.name}</span>
              <span style={{fontFamily:FONT_MONO,fontSize:11,color:r?.c,marginLeft:8}}>{p.rank} · {fmtMoney(r?.bid)}</span>
            </div>;})}
            {poolLeft===0 && <p style={{color:MUTE,fontFamily:FONT_LABEL,fontSize:13}}>Pool empty — all players drafted.</p>}
          </div>
        </div>
        <div>
          <SectionLabel>Auction Feed</SectionLabel>
          <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
            {(st.log||[]).map((line,i)=><div key={i} style={{fontFamily:FONT_MONO,fontSize:12,color:i===0?"#dce6ff":"rgba(200,215,255,0.5)",padding:"5px 10px",background:i===0?"rgba(61,123,255,0.06)":"transparent"}}>{line}</div>)}
          </div>
        </div>
      </div>
    </>}
  </div></Shell>;
}
