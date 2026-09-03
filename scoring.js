// SquabbleUP scoring engine
// Fair-play design: one shared data source (ESPN box scores), fixed public rules per
// sport, scores computed server-side for everyone, stored per player per day.
// A draft's total = sum of its players' daily points inside the draft's scoring window.

const PLAYERS = require("./public/players-data.js");

const LEAGUES = {
  NFL: ["football", "nfl"],
  CFB: ["football", "college-football"],
  NBA: ["basketball", "nba"],
  CBB: ["basketball", "mens-college-basketball"],
  MLB: ["baseball", "mlb"],
  NHL: ["hockey", "nhl"],
  UFC: ["mma", "ufc"],
  WCUP: ["soccer", "fifa.world"],
};

// ESPN scoreboard uses 2-letter abbreviations for some NBA teams; expand to match players-data
const ABBR_EXPAND = { SA: "SAS", GS: "GSW", NY: "NYK", NO: "NOP" };
function normTeamAbbr(abbr) { const a = (abbr || "").toUpperCase(); return ABBR_EXPAND[a] || a; }

// label-driven rules: `${statGroup}:${LABEL}` ('*' = any group). Public + standard.
const RULES = {
  football: {
    "passing:YDS": 0.04, "passing:TD": 4, "passing:INT": -2,
    "rushing:YDS": 0.1, "rushing:TD": 6,
    "receiving:REC": 0.5, "receiving:YDS": 0.1, "receiving:TD": 6,
    "fumbles:LOST": -2,
    "defensive:TOT": 1, "defensive:SACKS": 4,
    "interceptions:INT": 6,
    // ESPN's kicking box score already totals real NFL scoring (FG=3, XP=1) into a "PTS"
    // label per kicker — using that directly instead of trying to parse "FG"/"XP" (which
    // come as made/attempted strings like "2/3", not plain numbers).
    "kicking:PTS": 1,
  },
  basketball: { "*:PTS": 1, "*:REB": 1.2, "*:AST": 1.5, "*:STL": 3, "*:BLK": 3, "*:TO": -1 },
  baseball: {
    "batting:H": 3, "batting:R": 2, "batting:RBI": 2, "batting:BB": 2, "batting:HR": 3, "batting:SB": 5,
    "pitching:K": 2, "pitching:ER": -2, "pitching:IP": 2.25,
  },
  // NHL uses BS (blocked shots) label, not BLK
  hockey: { "*:G": 8, "*:A": 5, "*:SOG": 1.5, "*:BS": 1.3, "*:SV": 0.7, "*:GA": -3.5 },
};
// Football (NFL/CFB) skill positions — the only ones that can score under RULES.football.
// O-line (C/G/OT) and long snappers (LS) have no matching rule and can never score a point,
// so they stay excluded. Kickers (PK) DO score now (RULES.football's kicking:PTS) so they're
// included despite having no Sleeper projection coverage — real points on the board beats a
// pre-draft number, and the UI already shows "no proj yet" instead of pretending it's zero.
// Individual defensive stats (LB/DL/CB/S) do have a scoring rule too (defensive:*/
// interceptions:*), but stay excluded — Sleeper's projection map is offense+kicking only
// (SLEEPER_STAT_MAP.football), so defense would have zero projection coverage app-wide,
// not just a mostly-there long tail like kickers have.
const FOOTBALL_SKILL_POS = new Set(["QB", "RB", "WR", "TE", "PK"]);
// Soccer position abbreviations from ESPN
const SOC_POS = { G: "GK", D: "DEF", M: "MID", F: "FWD" };
// Multi-league list for general soccer (SOC sport)
const SOC_LEAGUES = ["usa.1", "uefa.champions", "eng.1", "esp.1", "ger.1", "ita.1", "fra.1", "conmebol.libertadores", "mex.1"];
const FAMILY = { NFL: "football", CFB: "football", NBA: "basketball", CBB: "basketball", MLB: "baseball", NHL: "hockey", UFC: "mma", WCUP: "soccer", SOC: "soccer" };

// golf placement points (final leaderboard position)
function golfPoints(pos) {
  if (!pos || pos < 1) return 0;
  if (pos === 1) return 30; if (pos === 2) return 20; if (pos === 3) return 18;
  if (pos === 4) return 16; if (pos === 5) return 14;
  if (pos <= 10) return 12; if (pos <= 20) return 8; if (pos <= 30) return 6;
  if (pos <= 40) return 5; if (pos <= 50) return 4;
  return 3; // made the cut / finished
}
// Tennis pts: match win 15, per set won 3, straight-sets bonus 5
// ESPN's tennis API has no per-point stats (no aces/double faults/break points anywhere —
// confirmed no working summary endpoint), but the scoreboard's linescores DO carry games
// won per set and tiebreak scores, which the old scoring ignored entirely (only used set
// *count*). A 6-0 6-0 blowout and a 7-6 7-6 nail-biter scored identically before; now games
// won add real granularity, and tiebreak/bagel/comeback bonuses reward how a match was won.
const TENNIS_MATCH_WIN = 15, TENNIS_SET = 3, TENNIS_GAME = 0.4, TENNIS_STRAIGHT = 5,
      TENNIS_TIEBREAK = 2, TENNIS_BAGEL = 3, TENNIS_COMEBACK = 4;

// ---------- name matching ----------
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
function buildPoolIndex(sport) {
  const idx = new Map();
  for (const p of PLAYERS.filter((x) => x.sp === sport)) {
    idx.set(norm(p.n), p.n);
    const parts = norm(p.n).split(" ");
    if (parts.length >= 2) idx.set(parts[0][0] + " " + parts[parts.length - 1], p.n); // "j smith"
  }
  return idx;
}
function matchPool(idx, name) {
  const n = norm(name);
  if (idx.has(n)) return idx.get(n);
  const parts = n.split(" ");
  if (parts.length >= 2) {
    const key = parts[0][0] + " " + parts[parts.length - 1];
    if (idx.has(key)) return idx.get(key);
  }
  return null;
}

// ---------- box score parsing ----------
// summary.boxscore.players: [{ statistics: [{ name, labels, athletes: [{ athlete:{displayName}, stats:[] }] }] } per team]
function scoreSummary(family, summary) {
  const rules = RULES[family];
  const out = new Map(); // displayName -> { pts, allParts: [] }
  for (const team of summary?.boxscore?.players || []) {
    for (const grp of team.statistics || []) {
      const gname = String(grp.type || grp.name || "").toLowerCase();
      const labels = (grp.labels || []).map((l) => String(l).toUpperCase());
      for (const a of grp.athletes || []) {
        const name = a?.athlete?.displayName;
        if (!name) continue;
        let pts = 0; const allParts = [];
        labels.forEach((lbl, i) => {
          const raw = String(a.stats?.[i] ?? "0");
          // made/attempted fields (kicking FG "2/3", XP "2/2") aren't a single number —
          // stripping non-digits would concatenate them into a nonsense value like 23.
          // None of these carry a scoring rule (only kicking:PTS does), so display them
          // as-is and skip scoring entirely rather than mangle them.
          if (raw.includes("/")) { allParts.push(`${raw} ${lbl.toLowerCase()}`); return; }
          let val = parseFloat(raw.replace(/[^0-9.\-]/g, "")) || 0;
          // ESPN baseball IP uses X.Y where Y = outs (0-2), not decimal fraction
          if (lbl === "IP" && val > 0) val = Math.floor(val) + ((Math.round(val * 10) % 10) / 3);
          if (!val) return;
          // collect every non-zero stat for display
          allParts.push(`${val} ${lbl.toLowerCase()}`);
          // only apply fantasy multiplier if rule exists
          const mult = rules[`${gname}:${lbl}`] ?? rules[`*:${lbl}`];
          if (mult !== undefined) pts += val * mult;
        });
        if (pts || allParts.length) {
          const cur = out.get(name) || { pts: 0, parts: [] };
          cur.pts += pts; cur.parts.push(...allParts);
          out.set(name, cur);
        }
      }
    }
  }
  return out;
}

// Soccer scoring — ESPN uses summary.rosters (not boxscore.players)
// G=6, A=4, SV=1, GK clean sheet +4, YC=-1, RC=-3, OG=-2
function scoreSoccer(summary) {
  const out = new Map();
  for (const team of summary.rosters || []) {
    for (const ath of team.roster || []) {
      const name = ath.athlete?.displayName;
      if (!name) continue;
      const stats = ath.stats || [];
      const get = (abbr) => stats.find((s) => s.abbreviation === abbr)?.value || 0;
      const g = get("G"); const a = get("A"); const sv = get("SV");
      const ga = get("GA"); const yc = get("YC"); const rc = get("RC"); const og = get("OG");
      let pts = 0; const parts = [];
      if (g)           { pts += g * 6;  parts.push(g + "G"); }
      if (a)           { pts += a * 4;  parts.push(a + "A"); }
      if (sv)          { pts += sv * 1; parts.push(sv + "SV"); }
      if (sv > 0 && ga === 0) { pts += 4; parts.push("CS"); } // GK clean sheet
      if (yc)          { pts += yc * -1; parts.push(yc + "YC"); }
      if (rc)          { pts += rc * -3; parts.push(rc + "RC"); }
      if (og)          { pts += og * -2; parts.push(og + "OG"); }
      if (pts || parts.length) out.set(name, { pts, parts });
    }
  }
  return out;
}

// return set of team abbreviations playing today for a sport
async function todaysTeams(sport) {
  const pair = LEAGUES[sport];
  if (!pair) return null;
  const day = etDateStr();
  try {
    const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${day}`);
    const teams = new Set();
    for (const ev of sb.events || []) {
      for (const comp of ev.competitions?.[0]?.competitors || []) {
        const abbr = normTeamAbbr(comp.team?.abbreviation);
        if (abbr) teams.add(abbr);
      }
    }
    return teams.size > 0 ? teams : null;
  } catch { return null; }
}

const _schedCache = new Map();
const _SCHED_TTL = 5 * 60 * 1000;
// Sports that pull live ESPN data benefit from a shorter cache so stale rosters refresh quickly
const _SCHED_TTL_SHORT = { MLB: 2 * 60 * 1000, GOLF: 60 * 1000, WCUP: 60 * 1000, SOC: 60 * 1000, UFC: 60 * 1000, TEN: 60 * 1000 };

async function _fetchSchedule(sport) {
  // Golf: pull actual tournament field from ESPN scoreboard competitors list
  if (sport === "GOLF") {
    try {
      const sb = await jget("https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard");
      const active = (sb.events || []).filter((ev) => ev.status?.type?.state !== "post");
      if (!active.length) return { players: null, matchups: {}, roster: [] };
      const ev0 = active.find((e) => e.status?.type?.state === "in") || active[0];
      const tournName = ev0?.shortName || ev0?.name || "PGA Tour";
      const roundDetail = ev0?.status?.type?.shortDetail || "";
      const golfLabel = roundDetail ? `${tournName} · ${roundDetail}` : tournName;
      const isLive = ev0?.status?.type?.state === "in";
      const names = new Set(); const matchups = {}; const roster = [];
      // ESPN includes the full tournament field (typically 70-150+ players) in
      // competitions[0].competitors once it's published — usually a few days before the
      // tournament starts. If it's empty, the field just isn't out yet. Never fall back to
      // the ~12-golfer static list here: next to a real field that size, a tiny stand-in
      // looks like a broken/truncated pool instead of the "come back later" state it is.
      const comps = ev0?.competitions?.[0]?.competitors || [];
      for (let idx = 0; idx < comps.length; idx++) {
        const comp = comps[idx];
        const name = comp.athlete?.displayName || comp.athlete?.fullName;
        if (!name || names.has(name)) continue;
        names.add(name);
        // r = competitor order from ESPN (leaderboard/world ranking order); used for sort
        const staticP = PLAYERS.find((p) => p.n === name && p.sp === "GOLF");
        const r = staticP?.r ?? (idx + 1) * 10;
        roster.push({ n: name, pos: "G", tm: "GOLF", sp: "GOLF", ev: golfLabel, r,
          ...(isLive ? { livelock: true } : {}) });
      }
      if (names.size > 0) matchups["GOLF"] = golfLabel;
      return { players: names.size > 0 ? names : null, matchups, roster };
    } catch { return { players: null, matchups: {}, roster: [] }; }
  }
  // UFC: fighters from tonight's card — or, on off days, the NEXT card (up to 14
  // days out). Never fall back to the static fighter list: it isn't tied to any
  // real booking, so it offers fighters who aren't fighting anytime soon.
  if (sport === "UFC") {
    const WT = {
      heavyweight: "HW", "light heavyweight": "LHW", middleweight: "MW",
      welterweight: "WW", lightweight: "LW", featherweight: "FW",
      bantamweight: "BW", flyweight: "FLW", "women's strawweight": "WSW",
      "women's flyweight": "WFLW", "women's bantamweight": "WBW", "women's featherweight": "WFW",
    };
    const short = (n) => { const p = n.trim().split(" "); return p.length >= 2 ? p[0][0] + ". " + p[p.length - 1] : n; };
    try {
      for (let i = 0; i < 14; i++) {
        const d = etDateObj(i);
        let sb;
        try { sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${dstr(d)}`); }
        catch { continue; }
        if (!sb.events?.length) continue;
        const future = i > 0;
        const dateLbl = future ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" }) : "";
        const names = new Set(); const roster = []; const matchups = {};
        for (const ev of sb.events || []) {
          const evName = ev.shortName || ev.name || "UFC";
          for (const comp of ev.competitions || []) {
            const cState = comp.status?.type?.state;
            if (cState === "post") continue;
            const livelock = cState === "in"; // fight underway — lock it
            const cs = comp.competitors || [];
            if (cs.length < 2) continue;
            const [aN, bN] = [cs[0], cs[1]].map((c) => c.athlete?.displayName);
            if (!aN || !bN) continue;
            // comp.type.abbreviation = "Featherweight"; text/name may say "Lightweight Championship"
            const wtText = (comp.type?.abbreviation || comp.type?.text || comp.type?.name || "").toLowerCase();
            const pos = Object.entries(WT).find(([k]) => wtText.includes(k))?.[1] || "MMA";
            const recStr = (c) => { const r = c.records?.find((x) => x.type === "total"); if (!r) return ""; const p = r.summary.split("-"); return p[2] === "0" ? `${p[0]}-${p[1]}` : r.summary; };
            const evTag = future ? ` · ${evName} ${dateLbl}` : "";
            names.add(aN); names.add(bN);
            roster.push({ n: aN, pos, tm: "vs " + short(bN), sp: "UFC", rec: recStr(cs[0]), ...(evTag ? { ev: "vs " + short(bN) + evTag } : {}), ...(livelock ? { livelock: true } : {}) });
            roster.push({ n: bN, pos, tm: "vs " + short(aN), sp: "UFC", rec: recStr(cs[1]), ...(evTag ? { ev: "vs " + short(aN) + evTag } : {}), ...(livelock ? { livelock: true } : {}) });
            // UFC has no shared "team" to group a fight by — key the game picker by each
            // fighter's own name instead (see INDIVIDUAL_SPORTS on the client)
            const fightLabel = `${aN} vs ${bN}`;
            matchups[aN] = fightLabel; matchups[bN] = fightLabel;
          }
        }
        // card found but every fight finished (late night) — keep looking ahead
        if (names.size > 0) return { players: names, matchups, roster };
      }
      return { players: new Set(), matchups: {}, roster: [] }; // no card in 14 days — nothing draftable
    } catch { return { players: null, matchups: {}, roster: [] }; }
  }
  // Tennis: pull actual match competitors from ESPN groupings (matches live under
  // ev.groupings[].competitions[], NOT ev.competitions[] which is always empty for tennis)
  // Only fetch today; fall back to tomorrow only when today has zero pre/in matches (rest day).
  if (sport === "TEN") {
    const names = new Set(); const matchups = {}; const roster = [];
    async function fetchTennisDay(day) {
      let found = 0;
      for (const tour of ["atp", "wta"]) {
        const pos = tour === "atp" ? "ATP" : "WTA";
        try {
          const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${day}`);
          for (const ev of sb.events || []) {
            const tournName = ev.shortName || ev.name || `${tour.toUpperCase()} Tennis`;
            const allMatches = [];
            for (const g of ev.groupings || []) for (const m of g.competitions || []) allMatches.push(m);
            for (const m of ev.competitions || []) allMatches.push(m);
            for (const match of allMatches) {
              const state = match.status?.type?.state;
              if (state === "post") continue;
              const cs = match.competitors || [];
              if (cs.length < 2) continue;
              const nameA = cs[0].athlete?.displayName;
              const nameB = cs[1].athlete?.displayName;
              // skip if either player is unknown/TBD (draw not yet set)
              if (!nameA || !nameB || nameA === "TBD" || nameB === "TBD") continue;
              const livelock = state === "in";
              found++;
              // tennis has no shared "team" to group a match by — key the game picker by
              // each player's own name instead (see INDIVIDUAL_SPORTS on the client)
              const matchLabel = `${nameA} vs ${nameB} · ${tournName}`;
              matchups[nameA] = matchLabel; matchups[nameB] = matchLabel;
              if (!names.has(nameA)) {
                names.add(nameA);
                roster.push({ n: nameA, pos, tm: "TEN", sp: "TEN",
                  ev: `vs ${nameB.split(" ").pop()} · ${tournName}`,
                  ...(livelock ? { livelock: true } : {}) });
              }
              if (!names.has(nameB)) {
                names.add(nameB);
                roster.push({ n: nameB, pos, tm: "TEN", sp: "TEN",
                  ev: `vs ${nameA.split(" ").pop()} · ${tournName}`,
                  ...(livelock ? { livelock: true } : {}) });
              }
            }
          }
        } catch {}
      }
      return found;
    }
    const todayFound = await fetchTennisDay(etDateStr());
    // only look at tomorrow if today is a complete rest day (no pre or in matches at all)
    if (todayFound === 0) await fetchTennisDay(etDateStr(1));
    return { players: names.size > 0 ? names : null, matchups, roster };
  }
  // World Cup — parallel team roster fetches; livelock in-progress matches; skip completed
  if (sport === "WCUP") {
    const names = new Set(); const matchups = {}; const roster = [];
    // matches kick off in every timezone worldwide, so check yesterday/today/tomorrow (UTC) —
    // any single day's boundary can miss a match still in progress or about to start
    const days = [-1, 0, 1].map((o) => dstr(new Date(Date.now() + o * 864e5)));
    const allEvents = [];
    await Promise.all(days.map(async (day) => {
      try {
        const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${day}`);
        for (const ev of sb.events || []) allEvents.push(ev);
      } catch {}
    }));
    // dedupe events by id (same match might appear on both days due to timezone)
    const seenEvIds = new Set();
    const events = allEvents.filter((ev) => { if (seenEvIds.has(ev.id)) return false; seenEvIds.add(ev.id); return true; });
    await Promise.all(events.map(async (ev) => {
      const evState = ev.status?.type?.state;
      if (evState === "post") return; // skip finished matches
      const livelock = evState === "in";
      const comps = ev.competitions?.[0]?.competitors || [];
      const away = comps.find((c) => c.homeAway === "away");
      const home = comps.find((c) => c.homeAway === "home");
      const label = (away && home)
        ? `${normTeamAbbr(away.team?.abbreviation)} vs ${normTeamAbbr(home.team?.abbreviation)}`
        : comps.map((c) => normTeamAbbr(c.team?.abbreviation)).filter(Boolean).join(" vs ");
      // fetch all team rosters in parallel
      await Promise.all(comps.map(async (comp) => {
        const abbr = normTeamAbbr(comp.team?.abbreviation);
        if (abbr) matchups[abbr] = label;
        const teamId = comp.team?.id;
        if (!teamId) return;
        try {
          const r = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams/${teamId}/roster`);
          for (const a of r.athletes || []) {
            const name = a.displayName; if (!name || names.has(name)) continue;
            const pos = SOC_POS[a.position?.abbreviation] || a.position?.abbreviation || "MID";
            names.add(name);
            roster.push({ n: name, pos, tm: abbr, sp: "WCUP", ev: label, ...(livelock ? { livelock: true } : {}) });
          }
        } catch {}
      }));
      // supplement with confirmed lineup from match summary when announced
      try {
        const summary = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${ev.id}`);
        for (const team of summary.rosters || []) {
          const abbr = normTeamAbbr(team.team?.abbreviation || "");
          for (const ath of team.roster || []) {
            const name = ath.athlete?.displayName; if (!name || names.has(name)) continue;
            const rawPos = ath.athlete?.position?.abbreviation || ath.position?.abbreviation || "";
            const pos = SOC_POS[rawPos] || rawPos || "MID";
            names.add(name);
            roster.push({ n: name, pos, tm: abbr, sp: "WCUP", ev: label, ...(livelock ? { livelock: true } : {}) });
          }
        }
      } catch {}
    }));
    return { players: names.size > 0 ? names : null, matchups, roster };
  }
  // Soccer (all leagues + World Cup) — parallel fetching, livelock in-progress, match labels
  if (sport === "SOC") {
    const names = new Set(); const matchups = {}; const roster = [];
    // matches kick off in every timezone worldwide, so check yesterday/today/tomorrow (UTC)
    const days = [-1, 0, 1].map((o) => dstr(new Date(Date.now() + o * 864e5)));
    const allLeagues = [...SOC_LEAGUES, "fifa.world"];

    // 1. Collect all events across all leagues for today in parallel
    const rawEvents = (await Promise.all(
      allLeagues.flatMap((lg) => days.map(async (day) => {
        try {
          const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${day}`);
          return (sb.events || []).map((ev) => ({ lg, ev }));
        } catch { return []; }
      }))
    )).flat();

    // 2. Dedupe events by ID (same match can appear across dates)
    const seenEvIds = new Set();
    const evList = rawEvents.filter(({ ev }) => {
      if (seenEvIds.has(ev.id)) return false; seenEvIds.add(ev.id); return true;
    });

    // 3. Process every match in parallel
    await Promise.all(evList.map(async ({ lg, ev }) => {
      const evState = ev.status?.type?.state;
      if (evState === "post") return;
      const livelock = evState === "in";
      const comps = ev.competitions?.[0]?.competitors || [];
      const away = comps.find((c) => c.homeAway === "away");
      const home = comps.find((c) => c.homeAway === "home");
      const label = (away && home)
        ? `${normTeamAbbr(away.team?.abbreviation)} vs ${normTeamAbbr(home.team?.abbreviation)}`
        : comps.map((c) => normTeamAbbr(c.team?.abbreviation)).filter(Boolean).join(" vs ");

      // team rosters — always available pre-game
      await Promise.all(comps.map(async (comp) => {
        const abbr = normTeamAbbr(comp.team?.abbreviation);
        if (abbr) matchups[abbr] = label;
        const teamId = comp.team?.id;
        if (!teamId) return;
        try {
          const r = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams/${teamId}/roster`);
          for (const a of r.athletes || []) {
            const name = a.displayName; if (!name || names.has(name)) continue;
            const pos = SOC_POS[a.position?.abbreviation] || a.position?.abbreviation || "MID";
            names.add(name);
            roster.push({ n: name, pos, tm: abbr, sp: "SOC", ev: label, ...(livelock ? { livelock: true } : {}) });
          }
        } catch {}
      }));

      // confirmed lineup from match summary (more accurate when announced)
      try {
        const summary = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/summary?event=${ev.id}`);
        for (const team of summary.rosters || []) {
          const abbr = normTeamAbbr(team.team?.abbreviation || "");
          for (const ath of team.roster || []) {
            const name = ath.athlete?.displayName; if (!name || names.has(name)) continue;
            const rawPos = ath.athlete?.position?.abbreviation || ath.position?.abbreviation || "";
            const pos = SOC_POS[rawPos] || rawPos || "MID";
            names.add(name);
            roster.push({ n: name, pos, tm: abbr, sp: "SOC", ev: label, ...(livelock ? { livelock: true } : {}) });
          }
        }
      } catch {}
    }));

    return { players: names.size > 0 ? names : null, matchups, roster };
  }
  const pair = LEAGUES[sport];
  if (!pair) return { players: null, matchups: {}, roster: [] };
  // known positions from static list take priority over ESPN's generic G/F/C
  const knownPos = new Map(PLAYERS.map((p) => [p.n, p.pos]));
  const MLB_PITCHER_POS = new Set(["SP", "RP", "P", "LHP", "RHP"]);
  // Turns one day's scoreboard into a pool. Returns null (not an empty pool) when the day
  // has nothing draftable — e.g. every game already finished — so the caller knows to keep
  // looking ahead instead of settling for an empty result on a day that "had events".
  async function processDay(sb) {
    const names = new Set(); const matchups = {}; const roster = [];
    const probablePitchers = new Set();
    if (sport === "MLB") {
      for (const ev of sb.events || []) {
        for (const comp of ev.competitions?.[0]?.competitors || []) {
          const pp = comp.probablePitcher?.displayName;
          if (pp) probablePitchers.add(pp);
        }
      }
    }
    for (const ev of sb.events || []) {
      // MLB: only games not yet started. All other sports keep in-progress games
      // visible but livelock their players — you can't draft someone mid-game.
      const evState = ev.status?.type?.state;
      if (sport === "MLB" ? evState !== "pre" : evState === "post") continue;
      const livelock = evState === "in";
      const comps = ev.competitions?.[0]?.competitors || [];
      const away = comps.find((c) => c.homeAway === "away");
      const home = comps.find((c) => c.homeAway === "home");
      const awayAbbr = normTeamAbbr(away?.team?.abbreviation);
      const homeAbbr = normTeamAbbr(home?.team?.abbreviation);
      const label = away && home ? `${awayAbbr} @ ${homeAbbr}` : comps.map((c) => normTeamAbbr(c.team?.abbreviation)).filter(Boolean).join(" vs ");
      for (const comp of comps) {
        const abbr = normTeamAbbr(comp.team?.abbreviation);
        const teamId = comp.team?.id;
        if (!abbr) continue;
        matchups[abbr] = label;
        let added = false;
        if (teamId) {
          try {
            const r = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/teams/${teamId}/roster`);
            // ESPN baseball/hockey group by position (Pitchers, Catchers, ...) — all draftable.
            // ESPN football (NFL/CFB) groups by roster status instead — offense/defense/specialTeam
            // are the active roster, but injuredReserveOrOut/suspended/practiceSquad are NOT
            // playing this week and must never enter the draft pool.
            // ESPN basketball returns flat athletes: [{displayName, ...}], no grouping at all.
            const ROSTER_STATUS_EXCLUDE = new Set(["injuredreserveorout", "suspended", "practicesquad"]);
            const rawAthletes = r.athletes || [];
            const athletes = rawAthletes
              .filter((a) => !a.items?.length || !ROSTER_STATUS_EXCLUDE.has(String(a.position || "").toLowerCase()))
              .flatMap((a) => a.items?.length ? a.items : (a.displayName ? [a] : []));
            for (const a of athletes) {
              if (a.displayName) {
                const rawPos = knownPos.get(a.displayName) || a.position?.abbreviation || "?";
                const pos = FAMILY[sport] === "soccer" ? (SOC_POS[rawPos] || rawPos) : rawPos;
                // MLB: skip pitchers not in probable starters list; when list is empty exclude all pitchers
                if (sport === "MLB" && MLB_PITCHER_POS.has(rawPos) && !probablePitchers.has(a.displayName)) continue;
                // NFL/CFB: only skill positions that can actually score under RULES.football
                if (FAMILY[sport] === "football" && !FOOTBALL_SKILL_POS.has(rawPos)) continue;
                names.add(a.displayName);
                roster.push({ n: a.displayName, pos, tm: abbr, sp: sport, ...(livelock ? { livelock: true } : {}) });
                added = true;
              }
            }
          } catch {}
        }
        // static fallback inherits the live lock, the MLB probable-pitcher filter, and the
        // football skill-position filter
        if (!added) PLAYERS.filter((p) => p.sp === sport && p.tm === abbr)
          .filter((p) => !(sport === "MLB" && MLB_PITCHER_POS.has(p.pos) && !probablePitchers.has(p.n)))
          .filter((p) => FAMILY[sport] !== "football" || FOOTBALL_SKILL_POS.has(p.pos))
          .forEach((p) => { names.add(p.n); roster.push({ ...p, ...(livelock ? { livelock: true } : {}) }); });
      }
    }
    return names.size > 0 ? { players: names, matchups, roster } : null;
  }
  try {
    const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${etDateStr()}`);
    const today = await processDay(sb);
    if (today) return { ...today, futureDate: null };
    // nothing draftable today (no events, or every game already finished/started) — look
    // ahead for the next real slate instead of falling back to a static "top players
    // league-wide" list that has no connection to who's actually playing when
    for (let i = 1; i <= 14; i++) {
      const d = etDateObj(i);
      let fsb;
      try { fsb = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${dstr(d)}`); }
      catch { continue; }
      const future = await processDay(fsb);
      if (future) {
        const futureDate = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });
        return { ...future, futureDate };
      }
    }
    return { players: null, matchups: {}, roster: [] };
  } catch { return { players: null, matchups: {}, roster: [] }; }
}

// Aggregates a whole week's games for weekly-cadence sports (NFL, CFB) so a host can build
// one draft spanning multiple game days — Wednesday's opener + Thursday's game + Sunday's
// full slate, all in the same squabble. Team abbreviations stay unique across a single
// week for these two sports (a team plays once), which daily-cadence sports (MLB/NBA/NHL)
// don't guarantee — a "week" of MLB has each team playing ~6 times, which would make the
// existing team-abbr-keyed gameFilter ambiguous about which specific game was meant. Not
// offered there for that reason.
//
// Bounding "this week": rather than a fixed day offset from *today* (which would cross into
// next week's games whenever today falls late in the current week — e.g. Monday, the last
// day of an NFL week, is only 3 days from the *next* week's Thursday opener), this bounds
// the window to 6 days from whichever day *first* turns up games. That correctly spans a
// single Wed/Thu-through-Monday week regardless of where "today" falls within it, and stays
// short of the ~7-day gap to the following week's opener.
const WEEK_SLATE_SPORTS = new Set(["NFL", "CFB"]);
// Unlike todaysSchedule(), this had no cache at all — every call fans out to a roster fetch
// per team across the whole week's games (dozens of requests for a full NFL/CFB slate), and
// it's called on every single pick for validation (scheduleFor() in server.js) plus every
// bot/auto-draft check. With no caching, every pick during a week-mode draft paid that full
// ESPN fetch fan-out synchronously — worse the closer to kickoff, as more of the week's slate
// populates. Same cache pattern as todaysSchedule() below.
const _weekSchedCache = new Map();
const _WEEK_SCHED_TTL = 3 * 60 * 1000;
async function weekSchedule(sport) {
  if (!WEEK_SLATE_SPORTS.has(sport)) return null;
  const hit = _weekSchedCache.get(sport);
  if (hit && Date.now() - hit.ts < _WEEK_SCHED_TTL) return hit.data;
  const data = await _weekScheduleUncached(sport);
  _weekSchedCache.set(sport, { data, ts: Date.now() });
  return data;
}
async function _weekScheduleUncached(sport) {
  const pair = LEAGUES[sport];
  if (!pair) return null;
  const knownPos = new Map(PLAYERS.map((p) => [p.n, p.pos]));
  const names = new Set(); const matchups = {}; const roster = [];
  const days = [];
  let firstGameDayIdx = null;
  for (let i = 0; i <= 13; i++) {
    if (firstGameDayIdx !== null && i - firstGameDayIdx > 6) break;
    const d = etDateObj(i);
    let sb;
    try { sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${dstr(d)}`); }
    catch { continue; }
    if (!sb.events?.length) continue;
    const dayGames = [];
    for (const ev of sb.events || []) {
      if (ev.status?.type?.state === "post") continue;
      const livelock = ev.status?.type?.state === "in";
      const comps = ev.competitions?.[0]?.competitors || [];
      const away = comps.find((c) => c.homeAway === "away");
      const home = comps.find((c) => c.homeAway === "home");
      const awayAbbr = normTeamAbbr(away?.team?.abbreviation);
      const homeAbbr = normTeamAbbr(home?.team?.abbreviation);
      const label = away && home ? `${awayAbbr} @ ${homeAbbr}` : comps.map((c) => normTeamAbbr(c.team?.abbreviation)).filter(Boolean).join(" vs ");
      const gameTeams = [];
      for (const comp of comps) {
        const abbr = normTeamAbbr(comp.team?.abbreviation);
        const teamId = comp.team?.id;
        if (!abbr) continue;
        matchups[abbr] = label;
        gameTeams.push(abbr);
        let added = false;
        if (teamId) {
          try {
            const r = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/teams/${teamId}/roster`);
            const ROSTER_STATUS_EXCLUDE = new Set(["injuredreserveorout", "suspended", "practicesquad"]);
            const rawAthletes = r.athletes || [];
            // weekSchedule is NFL/CFB only — always the football rule set, so skill
            // positions are always the ones that can score (see FOOTBALL_SKILL_POS)
            const athletes = rawAthletes
              .filter((a) => !a.items?.length || !ROSTER_STATUS_EXCLUDE.has(String(a.position || "").toLowerCase()))
              .flatMap((a) => a.items?.length ? a.items : (a.displayName ? [a] : []))
              .filter((a) => FOOTBALL_SKILL_POS.has(knownPos.get(a.displayName) || a.position?.abbreviation || "?"));
            if (athletes.length > 0) added = true;
            for (const a of athletes) {
              if (a.displayName && !names.has(a.displayName)) {
                const pos = knownPos.get(a.displayName) || a.position?.abbreviation || "?";
                names.add(a.displayName);
                roster.push({ n: a.displayName, pos, tm: abbr, sp: sport, ...(livelock ? { livelock: true } : {}) });
              }
            }
          } catch {}
        }
        if (!added) PLAYERS.filter((p) => p.sp === sport && p.tm === abbr && FOOTBALL_SKILL_POS.has(p.pos))
          .forEach((p) => { if (!names.has(p.n)) { names.add(p.n); roster.push({ ...p, ...(livelock ? { livelock: true } : {}) }); } });
      }
      if (gameTeams.length >= 2) dayGames.push({ label, teams: gameTeams });
    }
    if (dayGames.length) {
      if (firstGameDayIdx === null) firstGameDayIdx = i;
      days.push({
        date: dstr(d),
        label: d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" }),
        games: dayGames,
      });
    }
  }
  return { days, matchups, roster, players: names.size > 0 ? names : null };
}

// Survivor pools need a real week number + real kickoff timestamps + real win/loss —
// none of which weekSchedule() computes (it only bounds a "which games are on" window).
// ESPN's parameterless scoreboard call returns week.number, season, and per-event
// date/winner all in one shot, so there's no need for a hardcoded season-anchor date.
// `override` (season/week/seasonType) is for admin-gated testing only — never pass
// through from a public request.
async function survivorWeek(sport = "NFL", override = null) {
  const pair = LEAGUES[sport];
  if (!pair) return null;
  let sb;
  try {
    sb = override
      ? await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${override.season}&week=${override.week}&seasontype=${override.seasonType}`)
      : await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard`);
  } catch (e) { console.error("survivorWeek", sport, e.message); return null; }
  const weekNum = sb.week?.number, year = sb.season?.year, seasonType = sb.season?.type;
  if (weekNum == null || year == null) return null;
  const weekKey = `${year}-${seasonType}-${weekNum}`;
  const games = []; const teams = new Set();
  for (const ev of sb.events || []) {
    const comps = ev.competitions?.[0]?.competitors || [];
    const away = comps.find((c) => c.homeAway === "away");
    const home = comps.find((c) => c.homeAway === "home");
    const awayAbbr = normTeamAbbr(away?.team?.abbreviation);
    const homeAbbr = normTeamAbbr(home?.team?.abbreviation);
    if (!awayAbbr || !homeAbbr) continue;
    teams.add(awayAbbr); teams.add(homeAbbr);
    const completed = !!ev.status?.type?.completed;
    let winner = null;
    if (completed) { if (away?.winner) winner = awayAbbr; else if (home?.winner) winner = homeAbbr; }
    // Moneyline → implied win probability, de-vigged so the two sides sum to 100% (raw
    // moneylines always sum a bit over, since the sportsbook's margin is baked in — nobody
    // picking a team wants to see "58% / 49%" and wonder why that's not 100).
    const ml = ev.competitions?.[0]?.odds?.[0]?.moneyline;
    const awayOdds = ml?.away?.close?.odds ?? ml?.away?.open?.odds;
    const homeOdds = ml?.home?.close?.odds ?? ml?.home?.open?.odds;
    const impliedProb = (odds) => {
      const n = parseInt(odds, 10);
      if (!Number.isFinite(n) || n === 0) return null;
      return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
    };
    const awayRaw = impliedProb(awayOdds), homeRaw = impliedProb(homeOdds);
    let awayWinPct = null, homeWinPct = null;
    if (awayRaw != null && homeRaw != null) {
      const total = awayRaw + homeRaw;
      awayWinPct = Math.round((awayRaw / total) * 1000) / 10;
      homeWinPct = Math.round((homeRaw / total) * 1000) / 10;
    }
    games.push({
      id: ev.id, label: ev.shortName || `${awayAbbr} @ ${homeAbbr}`,
      away: awayAbbr, home: homeAbbr,
      awayLogo: away?.team?.logo || null, homeLogo: home?.team?.logo || null,
      awayWinPct, homeWinPct,
      kickoff: new Date(ev.date).getTime(),
      state: ev.status?.type?.state, completed, winner,
    });
  }
  const allFinal = games.length > 0 && games.every((g) => g.completed);
  return { weekKey, weekNumber: weekNum, season: year, seasonType, games, teams, allFinal };
}

async function todaysSchedule(sport) {
  const hit = _schedCache.get(sport);
  const ttl = _SCHED_TTL_SHORT[sport] || _SCHED_TTL;
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const data = await _fetchSchedule(sport);
  _schedCache.set(sport, { data, ts: Date.now() });
  return data;
}
async function todaysPoolPlayers(sport) { return (await todaysSchedule(sport)).players; }

// find the next calendar date (up to 14 days out) that has games for a sport
async function nextGameDay(sport) {
  if (sport === "GOLF") {
    // one scoreboard query already returns the next non-completed tournament, field
    // published or not — no need to loop day by day like the other sports
    try {
      const sb = await jget("https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard");
      const upcoming = (sb.events || []).find((ev) => ev.status?.type?.state !== "post");
      if (!upcoming?.date) return null;
      return new Date(upcoming.date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });
    } catch { return null; }
  }
  if (sport === "TEN") {
    for (let i = 1; i <= 14; i++) {
      const d = etDateObj(i);
      for (const tour of ["atp", "wta"]) {
        try {
          const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${dstr(d)}`);
          if (sb.events?.length > 0) return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });
        } catch {}
      }
    }
    return null;
  }
  if (sport === "SOC") {
    for (let i = 1; i <= 14; i++) {
      const d = new Date(Date.now() + i * 864e5);
      for (const lg of [...SOC_LEAGUES, "fifa.world"]) {
        try {
          const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${dstr(d)}`);
          if (sb.events?.length > 0) return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
        } catch {}
      }
    }
    return null;
  }
  const pair = LEAGUES[sport];
  if (!pair) return null;
  for (let i = 1; i <= 14; i++) {
    const d = etDateObj(i);
    try {
      const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${dstr(d)}`);
      if (sb.events?.length > 0) {
        return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });
      }
    } catch {}
  }
  return null;
}

// ---------- pollers ----------
async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const dstr = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

// American leagues (and ESPN's own scoreboard `dates=` bucketing) schedule around US Eastern
// time, not UTC. Plain UTC "today" rolls over at 8pm ET — right when evening games are still
// live — which would silently swap the draft pool to tomorrow's slate for hours every night.
// Anchor "today" to the Eastern calendar date instead so it matches what ESPN actually shows.
function etTodayParts() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t) => +parts.find((p) => p.type === t).value;
  return { y: get("year"), m: get("month"), d: get("day") };
}
function etDateObj(offsetDays = 0) {
  const { y, m, d } = etTodayParts();
  // noon UTC anchor sidesteps DST/rounding surprises when adding offset days
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt;
}
const etDateStr = (offsetDays = 0) => dstr(etDateObj(offsetDays));

async function pollLeagueDay(pool, sport, dayDate) {
  const [s, l] = LEAGUES[sport];
  const day = dstr(dayDate);
  const idx = buildPoolIndex(sport);
  let sb;
  try { sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/scoreboard?dates=${day}`); }
  catch (e) { console.error("scoreboard", sport, e.message); return; }

  // UFC: score directly from competition results — no boxscore.players
  if (sport === "UFC") {
    for (const ev of sb.events || []) {
      for (const comp of ev.competitions || []) {
        if (!comp.status?.type?.completed) continue;
        const winner = comp.competitors?.find((c) => c.winner);
        const loser  = comp.competitors?.find((c) => !c.winner);
        if (!winner?.athlete?.displayName) continue;
        const detail = comp.status?.type?.detail || "";
        const u = detail.toUpperCase();
        let pts = 10; const parts = ["W"];
        if (u.includes("KO") || u.includes("TKO")) { pts += 5; parts.push("KO/TKO"); }
        else if (u.includes("SUB")) { pts += 5; parts.push("Sub"); }
        else parts.push("Dec");
        const rm = detail.match(/R(?:ound\s*)?(\d+)/i);
        if (rm?.[1] === "1") { pts += 3; parts.push("R1"); }
        else if (rm?.[1] === "2") { pts += 1; parts.push("R2"); }
        const wName = matchPool(idx, winner.athlete.displayName) || winner.athlete.displayName;
        await upsertScore(pool, dayDate, "UFC", wName, pts, parts.join(" · "));
        if (loser?.athlete?.displayName) {
          const lName = matchPool(idx, loser.athlete.displayName) || loser.athlete.displayName;
          await upsertScore(pool, dayDate, "UFC", lName, 0, "L");
        }
      }
    }
    return;
  }

  await Promise.all((sb.events || []).map(async (ev) => {
    if (ev.status?.type?.state === "pre") return;
    let summary;
    try { summary = await jget(`https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/summary?event=${ev.id}`); }
    catch { return; }
    const scored = FAMILY[sport] === "soccer" ? scoreSoccer(summary) : scoreSummary(FAMILY[sport], summary);
    await Promise.all([...scored].map(([espnName, v]) => {
      const poolName = matchPool(idx, espnName) || espnName;
      return upsertScore(pool, dayDate, sport, poolName, Math.round(v.pts * 10) / 10, v.parts.join(" · "));
    }));
  }));
}

async function pollGolfDay(pool, dayDate) {
  const idx = buildPoolIndex("GOLF");
  let sb;
  try { sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard`); }
  catch (e) { return; }
  for (const ev of sb.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp || ev.status?.type?.state === "pre") continue;
    for (const c of comp.competitors || []) {
      const name = c.athlete?.displayName;
      const poolName = name && matchPool(idx, name);
      if (!poolName) continue;
      // use only ESPN's leaderboard position ID — never fall back to c.order (that's just
      // the competitor's index in the field, not an actual score position)
      const pos = parseInt(String(c.status?.position?.id || "0").replace(/\D/g, "")) || 0;
      if (!pos) continue; // no position yet = no score, don't write a 0 row
      const final = ev.status?.type?.completed;
      const pts = golfPoints(pos);
      const line = `position ${pos}${final ? " (final)" : " (live)"}`;
      await upsertScore(pool, dayDate, "GOLF", poolName, pts, line);
    }
  }
}

async function pollTennisDay(pool, dayDate) {
  const idx = buildPoolIndex("TEN");
  const day = dstr(dayDate);
  for (const tour of ["atp", "wta"]) {
    let sb;
    try { sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${day}`); }
    catch { continue; }
    const ptMap = new Map(), lineMap = new Map();
    for (const ev of sb.events || []) {
      const allMatches = [];
      for (const g of ev.groupings || []) for (const m of g.competitions || []) allMatches.push(m);
      for (const m of ev.competitions || []) allMatches.push(m);
      for (const m of allMatches) {
        const comps = m.competitors || [];
        if (comps.length < 2) continue;
        // only score completed matches where someone has won
        const hasWinner = comps.some(c => c.winner);
        if (!hasWinner) continue;
        for (const c of comps) {
          const name = c.athlete?.displayName || c.team?.displayName;
          if (!name) continue;
          const poolName = matchPool(idx, name);
          if (!poolName) continue;
          const isWinner = !!c.winner;
          const myLines = c.linescores || [];
          const oppLines = comps.find((x) => x !== c)?.linescores || [];
          // walk each set actually played: games won, tiebreaks won, and "bagel" sets (6-0)
          let setsWon = 0, gamesWon = 0, tiebreaksWon = 0, bagels = 0;
          myLines.forEach((ls, i) => {
            const myGames = ls.value ?? 0;
            const oppGames = oppLines[i]?.value ?? 0;
            gamesWon += myGames;
            if (ls.winner) {
              setsWon++;
              if (myGames === 6 && oppGames === 0) bagels++;
            }
            if (ls.tiebreak != null && ls.winner) tiebreaksWon++;
          });
          let pts = 0; const parts = [];
          if (isWinner) { pts += TENNIS_MATCH_WIN; parts.push("match W"); }
          if (setsWon > 0) { pts += setsWon * TENNIS_SET; parts.push(`${setsWon} sets`); }
          if (gamesWon > 0) { pts += gamesWon * TENNIS_GAME; parts.push(`${gamesWon} games`); }
          if (isWinner && setsWon > 0 && setsWon === myLines.length) { pts += TENNIS_STRAIGHT; parts.push("straight sets +5"); }
          if (tiebreaksWon > 0) { pts += tiebreaksWon * TENNIS_TIEBREAK; parts.push(`${tiebreaksWon} TB won`); }
          if (bagels > 0) { pts += bagels * TENNIS_BAGEL; parts.push(`${bagels} bagel${bagels > 1 ? "s" : ""}`); }
          if (isWinner && myLines[0] && !myLines[0].winner) { pts += TENNIS_COMEBACK; parts.push("comeback +4"); }
          pts = Math.round(pts * 10) / 10;
          if (pts > 0) {
            ptMap.set(poolName, (ptMap.get(poolName) || 0) + pts);
            lineMap.set(poolName, [...(lineMap.get(poolName) || []), parts.join(", ")]);
          }
        }
      }
    }
    for (const [poolName, pts] of ptMap) {
      await upsertScore(pool, dayDate, "TEN", poolName, pts, (lineMap.get(poolName) || []).join(" | "));
    }
  }
}

async function pollSocDay(pool, sport, dayDate) {
  const idx = buildPoolIndex(sport);
  const day = dstr(dayDate);
  for (const lg of [...SOC_LEAGUES, "fifa.world"]) {
    let sb;
    try { sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${day}`); }
    catch { continue; }
    for (const ev of sb.events || []) {
      if (ev.status?.type?.state === "pre") continue;
      let summary;
      try { summary = await jget(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/summary?event=${ev.id}`); }
      catch { continue; }
      const scored = scoreSoccer(summary);
      for (const [espnName, v] of scored) {
        const poolName = matchPool(idx, espnName) || espnName;
        await upsertScore(pool, dayDate, sport, poolName, Math.round(v.pts * 10) / 10, v.parts.join(" · "));
      }
    }
  }
}

async function upsertScore(pool, dayDate, sport, player, pts, line) {
  await pool.query(
    `INSERT INTO player_scores (day, sport, player, pts, line, first_scored_at) VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (day, sport, player) DO UPDATE SET pts=$4, line=$5, updated=now()`,
    [dayDate.toISOString().slice(0, 10), sport, player, pts, line]
  );
}

// poll today + yesterday (late finals) for every sport — all days in parallel, sports in parallel per day
async function pollAll(pool) {
  const days = [new Date(), new Date(Date.now() - 864e5)];
  await Promise.all(days.map((d) => Promise.all([
    ...Object.keys(LEAGUES).map((sport) => pollLeagueDay(pool, sport, d).catch((e) => console.error(sport, e.message))),
    pollGolfDay(pool, d).catch(() => {}),
    pollTennisDay(pool, d).catch(() => {}),
    pollSocDay(pool, "SOC", d).catch((e) => console.error("SOC", e.message)),
  ])));
  console.log("scoring poll done", new Date().toISOString());
}

// draft totals: per-player pts summed over the draft's window
async function draftScores(pool, state) {
  if (!state.scoring) return {};
  const players = state.seats.flatMap((s) => s.roster.map((p) => p.n));
  if (!players.length) return {};
  const r = await pool.query(
    `SELECT player, SUM(pts) AS pts,
            (ARRAY_AGG(line ORDER BY day DESC))[1] AS line
     FROM player_scores
     WHERE player = ANY($1) AND day >= $2::date AND day <= $3::date
       AND first_scored_at >= $4
     GROUP BY player`,
    [players, new Date(state.scoring.start).toISOString().slice(0, 10), new Date(state.scoring.end).toISOString().slice(0, 10), new Date(state.scoring.start).toISOString()]
  );
  const out = {};
  for (const row of r.rows) out[row.player] = { pts: Math.round(row.pts * 10) / 10, line: row.line || "" };
  return out;
}

// per-player per-day detail for a draft (in-depth matchup)
async function draftScoreDetail(pool, state) {
  if (!state.scoring) return {};
  const players = state.seats.flatMap((s) => s.roster.map((p) => p.n));
  if (!players.length) return {};
  const r = await pool.query(
    `SELECT player, day, pts, line FROM player_scores
     WHERE player = ANY($1) AND day >= $2::date AND day <= $3::date
       AND first_scored_at >= $4
     ORDER BY day DESC`,
    [players, new Date(state.scoring.start).toISOString().slice(0, 10), new Date(state.scoring.end).toISOString().slice(0, 10), new Date(state.scoring.start).toISOString()]
  );
  const out = {};
  for (const row of r.rows) {
    (out[row.player] = out[row.player] || []).push({
      day: row.day.toISOString ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
      pts: Math.round(row.pts * 10) / 10, line: row.line || "",
    });
  }
  return out;
}

// projected scores: per-player average pts over last 30 days (games played only)
async function projectedScores(pool, players) {
  if (!players || !players.length) return {};
  const r = await pool.query(
    `SELECT player, ROUND(AVG(pts)::numeric, 1) AS proj, COUNT(*) AS games
     FROM player_scores
     WHERE player = ANY($1)
       AND pts > 0
       AND day >= (CURRENT_DATE - INTERVAL '30 days')
     GROUP BY player`,
    [players]
  );
  const out = {};
  for (const row of r.rows) out[row.player] = { proj: parseFloat(row.proj), games: parseInt(row.games) };
  return out;
}

// DEMO MODE: seed plausible-but-fake stat days so the full scoring flow is visible
// before a real slate runs. Lines are tagged (demo) so nobody mistakes them for real.
async function seedDemo(pool) {
  const days = [new Date(), new Date(Date.now() - 864e5)];
  const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
  for (const d of days) {
    for (const p of PLAYERS) {
      if (Math.random() < 0.25) continue; // some players sit
      let pts = 0, line = "";
      if (p.sp === "NBA" || p.sp === "CBB") {
        const P = rnd(8, 38), R = rnd(2, 12), A = rnd(1, 11), S = rnd(0, 3), Bk = rnd(0, 3), T = rnd(0, 5);
        pts = P + R * 1.2 + A * 1.5 + S * 3 + Bk * 3 - T;
        line = `${P} pts, ${R} reb, ${A} ast (demo)`;
      } else if (p.sp === "NFL" || p.sp === "CFB") {
        if (p.pos === "QB") { const Y = rnd(150, 380), T = rnd(0, 4), I = rnd(0, 2); pts = Y * .04 + T * 4 - I * 2; line = `${Y} pass yds, ${T} TD (demo)`; }
        else if (p.pos === "RB") { const Y = rnd(30, 160), T = rnd(0, 2); pts = Y * .1 + T * 6; line = `${Y} rush yds, ${T} TD (demo)`; }
        else { const Rc = rnd(2, 11), Y = rnd(20, 150), T = rnd(0, 2); pts = Rc * .5 + Y * .1 + T * 6; line = `${Rc} rec, ${Y} yds, ${T} TD (demo)`; }
      } else if (p.sp === "MLB") {
        const H = rnd(0, 4), R = rnd(0, 2), RBI = rnd(0, 4); pts = H * 3 + R * 2 + RBI * 2; line = `${H} H, ${R} R, ${RBI} RBI (demo)`;
      } else if (p.sp === "NHL") {
        const G = rnd(0, 2), A = rnd(0, 3), SOG = rnd(1, 7); pts = G * 8 + A * 5 + SOG * 1.5; line = `${G} G, ${A} A, ${SOG} SOG (demo)`;
      } else if (p.sp === "GOLF") {
        const pos = rnd(1, 50); pts = golfPoints(pos); line = `position ${pos} (demo)`;
      } else if (p.sp === "TEN") {
        const w = rnd(0, 1); const dSets = w ? rnd(2, 3) : rnd(0, 2);
        const games = dSets * rnd(4, 7); const tb = rnd(0, 1); const bagel = rnd(0, 4) === 0 ? 1 : 0;
        pts = w * TENNIS_MATCH_WIN + dSets * TENNIS_SET + games * TENNIS_GAME
          + (w && dSets >= 2 && rnd(0, 1) ? TENNIS_STRAIGHT : 0) + tb * TENNIS_TIEBREAK + bagel * TENNIS_BAGEL;
        line = w ? `match W, ${dSets} sets, ${games} games (demo)` : `lost, ${dSets} sets, ${games} games (demo)`;
        if (!w) continue;
      }
      await upsertScore(pool, d, p.sp, p.n, Math.round(pts * 10) / 10, line);
    }
  }
  console.log("DEMO stats seeded (today + yesterday). Unset DEMO_STATS for real data only.");
}

// ─── Sleeper API integration ─────────────────────────────────────────────────
const SLEEPER_SPORT = { NBA: "nba", NFL: "nfl", MLB: "baseball", NHL: "hockey" };

// Sleeper stat keys → our RULES keys
const SLEEPER_STAT_MAP = {
  basketball: [
    ["pts", "*:PTS"], ["reb", "*:REB"], ["ast", "*:AST"],
    ["stl", "*:STL"], ["blk", "*:BLK"], ["to", "*:TO"],
  ],
  football: [
    ["pass_yd", "passing:YDS"], ["pass_td", "passing:TD"], ["pass_int", "passing:INT"],
    ["rush_yd", "rushing:YDS"], ["rush_td", "rushing:TD"],
    ["rec", "receiving:REC"], ["rec_yd", "receiving:YDS"], ["rec_td", "receiving:TD"],
    ["fum_lost", "fumbles:LOST"],
  ],
};

function sleeperPts(stats, family) {
  let pts = 0;
  for (const [sk, rk] of (SLEEPER_STAT_MAP[family] || [])) {
    const val = parseFloat(stats[sk] ?? stats[sk + "_ppr"] ?? 0) || 0;
    const mult = RULES[family]?.[rk];
    if (mult !== undefined && val) pts += val * mult;
  }
  return Math.round(pts * 10) / 10;
}

// 1-hour in-memory cache for player roster data
let _slPlayerCache = {}, _slPlayerCacheT = {};
async function sleeperPlayerMap(sport) {
  const ss = SLEEPER_SPORT[sport];
  if (!ss) return null;
  const now = Date.now();
  if (_slPlayerCache[sport] && now - _slPlayerCacheT[sport] < 3_600_000) return _slPlayerCache[sport];
  try {
    const raw = await jget(`https://api.sleeper.app/v1/players/${ss}`);
    const map = new Map(); // norm(fullName) → { id, status, thumb }
    for (const [id, p] of Object.entries(raw || {})) {
      if (!p.full_name) continue;
      // Sleeper returns full words or abbrevs depending on sport — normalize all to short codes
      const rawInj = p.injury_status || null;
      const INJ_NORM = {
        Questionable: "Q", Doubtful: "D", Out: "O", Probable: "P",
        "Injured Reserve": "IR", IR: "IR",       // NHL uses short "IR"
        "Day-To-Day": "Q", DTD: "Q",             // baseball/hockey day-to-day ≈ questionable
        IL10: "IL", IL15: "IL", IL60: "IL",      // baseball injured list tiers
        IL: "IL", "10-Day IL": "IL", "15-Day IL": "IL", "60-Day IL": "IL",
      };
      const status = INJ_NORM[rawInj] || rawInj;
      map.set(norm(p.full_name), {
        id,
        status,
        thumb: `https://sleepercdn.com/content/${ss}/players/thumb/${id}.jpg`,
      });
    }
    _slPlayerCache[sport] = map;
    _slPlayerCacheT[sport] = now;
    return map;
  } catch { return null; }
}

// Estimate current Sleeper season + week for NBA/NFL
function sleeperWeek(sport) {
  const now = new Date();
  const m = now.getMonth() + 1, y = now.getFullYear();
  if (sport === "NBA") {
    const season = m >= 10 ? y : y - 1;
    if (m >= 4 && m <= 6) { // playoffs
      const w = Math.max(1, Math.ceil((now - new Date(y, 3, 12)) / 604_800_000));
      return { type: "post", season, week: w };
    }
    const w = Math.max(1, Math.ceil((now - new Date(season, 9, 1)) / 604_800_000));
    return { type: "regular", season, week: Math.min(w, 26) };
  }
  if (sport === "NFL") {
    const season = m >= 8 ? y : y - 1;
    if (m <= 2 && season < y) { // playoffs Jan-Feb
      const w = Math.max(1, Math.ceil((now - new Date(y, 0, 8)) / 604_800_000));
      return { type: "post", season, week: Math.min(w, 4) };
    }
    const w = Math.max(1, Math.ceil((now - new Date(season, 8, 5)) / 604_800_000));
    return { type: "regular", season, week: Math.min(w, 18) };
  }
  return null;
}

// 30-min cache for projections
let _slProjCache = {}, _slProjCacheT = {};
async function sleeperProjectionMap(sport) {
  const ss = SLEEPER_SPORT[sport];
  const family = FAMILY[sport];
  if (!ss || !family) return null;
  const now = Date.now();
  if (_slProjCache[sport] && now - _slProjCacheT[sport] < 1_800_000) return _slProjCache[sport];
  const wk = sleeperWeek(sport);
  if (!wk) return null;
  for (const w of [wk.week, wk.week - 1]) {
    if (w < 1) continue;
    try {
      const data = await jget(`https://api.sleeper.app/v1/projections/${ss}/${wk.type}/${wk.season}/${w}`);
      if (data && Object.keys(data).length > 5) {
        _slProjCache[sport] = { data, family };
        _slProjCacheT[sport] = now;
        return _slProjCache[sport];
      }
    } catch {}
  }
  return null;
}

// Main export: returns { proj: {name→{pts,source}}, status: {name→{status,thumb}} }
async function sleeperEnrich(sport, playerNames) {
  const [playerMap, projResult] = await Promise.all([
    sleeperPlayerMap(sport).catch(() => null),
    sleeperProjectionMap(sport).catch(() => null),
  ]);
  const result = { proj: {}, status: {} };
  if (!playerMap) return result;

  // Match our pool names → Sleeper entries
  const poolToSleeper = new Map();
  for (const pname of playerNames) {
    const entry = playerMap.get(norm(pname));
    if (entry) poolToSleeper.set(pname, entry);
  }

  // Status / thumbnails
  for (const [pname, entry] of poolToSleeper) {
    result.status[pname] = { status: entry.status, thumb: entry.thumb };
  }

  // Projections — build sleeperId → poolName, then score each
  if (projResult?.data) {
    const idToName = new Map();
    for (const [pname, entry] of poolToSleeper) idToName.set(entry.id, pname);
    for (const [sid, stats] of Object.entries(projResult.data)) {
      const pname = idToName.get(sid);
      if (!pname) continue;
      const pts = sleeperPts(stats, projResult.family);
      if (pts > 0) result.proj[pname] = { proj: pts, source: "sleeper" };
    }
  }
  return result;
}
// ─────────────────────────────────────────────────────────────────────────────

// UFC/tennis have no shared "team" — matchups are keyed by each player's own name instead
// (see the UFC/TEN branches of _fetchSchedule). Keep this in sync with the client's copy.
const INDIVIDUAL_SPORTS = new Set(["UFC", "TEN"]);

module.exports = { pollAll, draftScores, draftScoreDetail, projectedScores, sleeperEnrich, seedDemo, scoreSummary, todaysTeams, todaysPoolPlayers, todaysSchedule, weekSchedule, WEEK_SLATE_SPORTS, nextGameDay, RULES, FAMILY, INDIVIDUAL_SPORTS, golfPoints, matchPool, buildPoolIndex, norm, survivorWeek };
