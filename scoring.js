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
  },
  basketball: { "*:PTS": 1, "*:REB": 1.2, "*:AST": 1.5, "*:STL": 3, "*:BLK": 3, "*:TO": -1 },
  baseball: {
    "batting:H": 3, "batting:R": 2, "batting:RBI": 2, "batting:BB": 2, "batting:HR": 3, "batting:SB": 5,
    "pitching:K": 2, "pitching:ER": -2, "pitching:IP": 2.25,
  },
  // NHL uses BS (blocked shots) label, not BLK
  hockey: { "*:G": 8, "*:A": 5, "*:SOG": 1.5, "*:BS": 1.3, "*:SV": 0.7, "*:GA": -3.5 },
};
const FAMILY = { NFL: "football", CFB: "football", NBA: "basketball", CBB: "basketball", MLB: "baseball", NHL: "hockey", UFC: "mma" };

// golf placement points (final leaderboard position)
function golfPoints(pos) {
  if (!pos || pos < 1) return 0;
  if (pos === 1) return 30; if (pos === 2) return 20; if (pos === 3) return 18;
  if (pos === 4) return 16; if (pos === 5) return 14;
  if (pos <= 10) return 12; if (pos <= 20) return 8; if (pos <= 30) return 6;
  if (pos <= 40) return 5; if (pos <= 50) return 4;
  return 3; // made the cut / finished
}
const TENNIS_WIN = 10;

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

// return set of team abbreviations playing today for a sport
async function todaysTeams(sport) {
  const pair = LEAGUES[sport];
  if (!pair) return null;
  const day = dstr(new Date());
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

async function _fetchSchedule(sport) {
  // Golf: check for active/upcoming PGA tournament
  if (sport === "GOLF") {
    try {
      const sb = await jget("https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard");
      // include "pre" (upcoming) and "in" (in-progress) tournaments — exclude only finished ("post")
      const active = (sb.events || []).filter((ev) => ev.status?.type?.state !== "post");
      if (!active.length) return { players: null, matchups: {}, roster: [] };
      // prefer "in" (live) over "pre" for the tournament name
      const ev0 = active.find((e) => e.status?.type?.state === "in") || active[0];
      const tournName = ev0?.shortName || ev0?.name || "PGA Tour";
      const names = new Set(); const matchups = {}; const roster = [];
      for (const p of PLAYERS.filter((x) => x.sp === "GOLF")) { names.add(p.n); matchups[p.tm] = tournName; roster.push(p); }
      return { players: names.size > 0 ? names : null, matchups, roster };
    } catch { return { players: null, matchups: {}, roster: [] }; }
  }
  // UFC: fighters from tonight's card
  if (sport === "UFC") {
    const day = dstr(new Date());
    try {
      const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${day}`);
      if (!sb.events?.length) return { players: null, matchups: {}, roster: [] };
      const WT = {
        heavyweight: "HW", "light heavyweight": "LHW", middleweight: "MW",
        welterweight: "WW", lightweight: "LW", featherweight: "FW",
        bantamweight: "BW", flyweight: "FLW", "women's strawweight": "WSW",
        "women's flyweight": "WFLW", "women's bantamweight": "WBW", "women's featherweight": "WFW",
      };
      const short = (n) => { const p = n.trim().split(" "); return p.length >= 2 ? p[0][0] + ". " + p[p.length - 1] : n; };
      const names = new Set(); const roster = [];
      for (const ev of sb.events || []) {
        for (const comp of ev.competitions || []) {
          if (comp.status?.type?.state === "post") continue;
          const cs = comp.competitors || [];
          if (cs.length < 2) continue;
          const [aN, bN] = [cs[0], cs[1]].map((c) => c.athlete?.displayName);
          if (!aN || !bN) continue;
          // comp.type.text may be "Lightweight Championship", "Middleweight", etc. — use includes()
          const wtText = (comp.type?.text || comp.type?.name || "").toLowerCase();
          const pos = Object.entries(WT).find(([k]) => wtText.includes(k))?.[1] || "MMA";
          names.add(aN); names.add(bN);
          roster.push({ n: aN, pos, tm: "vs " + short(bN), sp: "UFC" });
          roster.push({ n: bN, pos, tm: "vs " + short(aN), sp: "UFC" });
        }
      }
      return { players: names.size > 0 ? names : null, matchups: {}, roster };
    } catch { return { players: null, matchups: {}, roster: [] }; }
  }
  // Tennis: check ATP/WTA events today
  if (sport === "TEN") {
    const day = dstr(new Date()); const names = new Set(); const matchups = {}; const roster = [];
    for (const tour of ["atp", "wta"]) {
      try {
        const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/tennis/${tour}/scoreboard?dates=${day}`);
        // include "pre" (upcoming) and "in" (in-progress) — exclude only "post" (finished)
        const active = (sb.events || []).filter((ev) => ev.status?.type?.state !== "post");
        if (!active.length) continue;
        const ev0 = active.find((e) => e.status?.type?.state === "in") || active[0];
        const tournName = ev0?.shortName || ev0?.name || `${tour.toUpperCase()} Tennis`;
        const pos = tour === "atp" ? "ATP" : "WTA";
        for (const p of PLAYERS.filter((x) => x.sp === "TEN" && x.pos === pos)) { names.add(p.n); matchups[p.tm] = tournName; roster.push(p); }
      } catch {}
    }
    return { players: names.size > 0 ? names : null, matchups, roster };
  }
  const pair = LEAGUES[sport];
  if (!pair) return { players: null, matchups: {}, roster: [] };
  const day = dstr(new Date());
  try {
    const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${day}`);
    if (!sb.events?.length) return { players: null, matchups: {}, roster: [] };
    const names = new Set(); const matchups = {}; const roster = [];
    // known positions from static list take priority over ESPN's generic G/F/C
    const knownPos = new Map(PLAYERS.map((p) => [p.n, p.pos]));
    for (const ev of sb.events || []) {
      // exclude only fully finished games — "pre" (not started) and "in" (in progress) are both draftable
      if (ev.status?.type?.state === "post") continue;
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
            // ESPN baseball/hockey returns grouped athletes: [{position, items:[...]}]
            // ESPN basketball/football returns flat athletes: [{displayName, ...}]
            const rawAthletes = r.athletes || [];
            const athletes = rawAthletes.flatMap((a) => a.items?.length ? a.items : (a.displayName ? [a] : []));
            for (const a of athletes) {
              if (a.displayName) {
                const pos = knownPos.get(a.displayName) || a.position?.abbreviation || "?";
                names.add(a.displayName);
                roster.push({ n: a.displayName, pos, tm: abbr, sp: sport });
                added = true;
              }
            }
          } catch {}
        }
        if (!added) PLAYERS.filter((p) => p.sp === sport && p.tm === abbr).forEach((p) => { names.add(p.n); roster.push(p); });
      }
    }
    return { players: names.size > 0 ? names : null, matchups, roster };
  } catch { return { players: null, matchups: {}, roster: [] }; }
}

async function todaysSchedule(sport) {
  const hit = _schedCache.get(sport);
  if (hit && Date.now() - hit.ts < _SCHED_TTL) return hit.data;
  const data = await _fetchSchedule(sport);
  _schedCache.set(sport, { data, ts: Date.now() });
  return data;
}
async function todaysPoolPlayers(sport) { return (await todaysSchedule(sport)).players; }

// find the next calendar date (up to 14 days out) that has games for a sport
async function nextGameDay(sport) {
  const pair = LEAGUES[sport];
  if (!pair) return null;
  for (let i = 1; i <= 14; i++) {
    const d = new Date(Date.now() + i * 864e5);
    try {
      const sb = await jget(`https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${dstr(d)}`);
      if (sb.events?.length > 0) {
        return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
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

  for (const ev of sb.events || []) {
    const state = ev.status?.type?.state;
    if (state === "pre") continue;
    let summary;
    try { summary = await jget(`https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/summary?event=${ev.id}`); }
    catch (e) { continue; }
    const scored = scoreSummary(FAMILY[sport], summary);
    for (const [espnName, v] of scored) {
      // use canonical name from our pool if available, otherwise store ESPN displayName directly
      const poolName = matchPool(idx, espnName) || espnName;
      await upsertScore(pool, dayDate, sport, poolName, Math.round(v.pts * 10) / 10, v.parts.join(" · "));
    }
  }
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
      const pos = parseInt(String(c.status?.position?.id || c.order || "0").replace(/\D/g, "")) || 0;
      const final = ev.status?.type?.completed;
      const pts = golfPoints(pos); // award live position points, update when final
      const line = pos ? `position ${pos}${final ? " (final)" : " (live)"}` : "";
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
    const wins = new Map();
    for (const ev of sb.events || []) {
      // matches live in groupings[].competitions[], not ev.competitions
      const allMatches = [];
      for (const g of ev.groupings || []) {
        for (const m of g.competitions || []) allMatches.push(m);
      }
      // fallback: direct competitions on event
      for (const m of ev.competitions || []) allMatches.push(m);
      for (const m of allMatches) {
        for (const c of m.competitors || []) {
          const name = c.athlete?.displayName || c.team?.displayName;
          if (!name || !c.winner) continue;
          const poolName = matchPool(idx, name);
          if (poolName) wins.set(poolName, (wins.get(poolName) || 0) + 1);
        }
      }
    }
    for (const [poolName, w] of wins) {
      await upsertScore(pool, dayDate, "TEN", poolName, w * TENNIS_WIN, `${w} match win${w > 1 ? "s" : ""}`);
    }
  }
}

async function upsertScore(pool, dayDate, sport, player, pts, line) {
  await pool.query(
    `INSERT INTO player_scores (day, sport, player, pts, line) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (day, sport, player) DO UPDATE SET pts=$4, line=$5, updated=now()`,
    [dayDate.toISOString().slice(0, 10), sport, player, pts, line]
  );
}

// poll today + yesterday (late finals) for every sport
async function pollAll(pool) {
  const days = [new Date(), new Date(Date.now() - 864e5)];
  for (const d of days) {
    for (const sport of Object.keys(LEAGUES)) await pollLeagueDay(pool, sport, d).catch((e) => console.error(sport, e.message));
    await pollGolfDay(pool, d).catch(() => {});
    await pollTennisDay(pool, d).catch(() => {});
  }
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
     GROUP BY player`,
    [players, new Date(state.scoring.start).toISOString().slice(0, 10), new Date(state.scoring.end).toISOString().slice(0, 10)]
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
     ORDER BY day DESC`,
    [players, new Date(state.scoring.start).toISOString().slice(0, 10), new Date(state.scoring.end).toISOString().slice(0, 10)]
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
        const w = rnd(0, 1); pts = w * TENNIS_WIN; line = w ? "1 match win (demo)" : "lost (demo)";
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

module.exports = { pollAll, draftScores, draftScoreDetail, projectedScores, sleeperEnrich, seedDemo, scoreSummary, todaysTeams, todaysPoolPlayers, todaysSchedule, nextGameDay, RULES, FAMILY, golfPoints, matchPool, buildPoolIndex, norm };
