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
};

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
const FAMILY = { NFL: "football", CFB: "football", NBA: "basketball", CBB: "basketball", MLB: "baseball", NHL: "hockey" };

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
        const abbr = comp.team?.abbreviation;
        if (abbr) teams.add(abbr.toUpperCase());
      }
    }
    return teams.size > 0 ? teams : null;
  } catch { return null; }
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
  for (const ev of sb.events || []) {
    const state = ev.status?.type?.state;
    if (state === "pre") continue;
    let summary;
    try { summary = await jget(`https://site.api.espn.com/apis/site/v2/sports/${s}/${l}/summary?event=${ev.id}`); }
    catch (e) { continue; }
    const scored = scoreSummary(FAMILY[sport], summary);
    for (const [espnName, v] of scored) {
      const poolName = matchPool(idx, espnName);
      if (!poolName) continue;
      await upsertScore(pool, dayDate, sport, poolName, Math.round(v.pts * 10) / 10, v.parts.join(", "));
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

module.exports = { pollAll, draftScores, draftScoreDetail, projectedScores, seedDemo, scoreSummary, todaysTeams, RULES, FAMILY, golfPoints, matchPool, buildPoolIndex, norm };
