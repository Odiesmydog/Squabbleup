// SquabbleUP multiplayer server
// env: DATABASE_URL (Neon), PORT
const express = require("express");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false } });

// ---------------- db ----------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL, av TEXT, img TEXT,
      friendcode TEXT UNIQUE NOT NULL,
      created TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS friendships (
      a UUID NOT NULL, b UUID NOT NULL, PRIMARY KEY (a, b)
    );
    CREATE TABLE IF NOT EXISTS drafts (
      code TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      participants UUID[] DEFAULT '{}',
      updated TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS player_scores (
      day DATE NOT NULL, sport TEXT NOT NULL, player TEXT NOT NULL,
      pts REAL NOT NULL DEFAULT 0, line TEXT, updated TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (day, sport, player)
    );
    CREATE TABLE IF NOT EXISTS invites (
      id BIGSERIAL PRIMARY KEY,
      draft_code TEXT NOT NULL, to_user UUID NOT NULL,
      from_name TEXT, created TIMESTAMPTZ DEFAULT now(),
      UNIQUE (draft_code, to_user)
    );
  `);
  console.log("db ready");
}

const code6 = () => crypto.randomBytes(4).toString("base64").replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase().padEnd(6, "X");

// ---------------- snake helpers ----------------
const pickerIndex = (s) => {
  const n = s.seats.length, p = s.picks.length;
  const r = Math.floor(p / n), i = p % n;
  return r % 2 === 0 ? i : n - 1 - i;
};
const isDone = (s) => s.picks.length >= s.seats.length * s.rounds;

// ---------------- ws ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const subs = new Map(); // draftCode -> Set<ws>

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const code = (url.searchParams.get("draft") || "").toUpperCase();
  if (!code) return ws.close();
  if (!subs.has(code)) subs.set(code, new Set());
  subs.get(code).add(ws);
  ws.on("close", () => subs.get(code)?.delete(ws));
});

async function broadcast(code) {
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  if (!r.rows[0]) return;
  const msg = JSON.stringify({ type: "state", state: r.rows[0].state });
  for (const ws of subs.get(code) || []) {
    if (ws.readyState === 1) ws.send(msg);
  }
  scheduleBot(code, r.rows[0].state);
}

// ---------------- bot picks (server-side) ----------------
const PLAYERS = require("./public/players-data.js");
const scoring = require("./scoring.js");
const botTimers = new Map();
function scheduleBot(code, s) {
  if (s.status !== "active" || isDone(s)) return;
  const seat = s.seats[pickerIndex(s)];
  if (!seat.bot || botTimers.has(code)) return;
  botTimers.set(code, setTimeout(async () => {
    botTimers.delete(code);
    const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
    const st = r.rows[0]?.state;
    if (!st || st.status !== "active" || isDone(st)) return;
    const cur = st.seats[pickerIndex(st)];
    if (!cur.bot) return;
    const taken = new Set(st.picks.map((p) => p.player));
    const avail = PLAYERS
      .filter((p) => !taken.has(p.n))
      .filter((p) => st.sport === "ALL" || p.sp === st.sport)
      .sort((a, b) => a.r - b.r)
      .slice(0, 3);
    const pick = avail[Math.floor(Math.random() * avail.length)];
    if (!pick) return;
    applyPick(st, pick);
    if (isDone(st)) finishDraft(st);
    await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [st, code]);
    broadcast(code);
  }, 1400));
}

function applyPick(st, p) {
  const idx = pickerIndex(st);
  st.picks.push({ seat: idx, player: p.n, pos: p.pos, sp: p.sp, tm: p.tm });
  st.seats[idx].roster.push({ n: p.n, pos: p.pos, sp: p.sp, tm: p.tm });
}
const SCORING_DAYS = { NFL: 7, CFB: 7, NBA: 1, CBB: 1, MLB: 1, NHL: 1, GOLF: 4, TEN: 1 };
function finishDraft(st) {
  st.status = "done";
  const days = SCORING_DAYS[st.sport] || 1;
  st.scoring = { start: Date.now(), end: Date.now() + days * 864e5 };
}

// ---------------- api ----------------
const ah = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "server error" }); });

// register / update profile
app.post("/api/register", ah(async (req, res) => {
  let { id, name, av, img } = req.body;
  name = String(name || "Player").slice(0, 14);
  av = String(av || "🙂").slice(0, 4);
  img = String(img || "").slice(0, 300);
  if (id) {
    const r = await pool.query("UPDATE users SET name=$2, av=$3, img=$4 WHERE id=$1 RETURNING *", [id, name, av, img]);
    if (r.rows[0]) return res.json(r.rows[0]);
  }
  id = crypto.randomUUID();
  let fc;
  for (;;) { fc = code6(); const c = await pool.query("SELECT 1 FROM users WHERE friendcode=$1", [fc]); if (!c.rows.length) break; }
  const r = await pool.query("INSERT INTO users (id, name, av, img, friendcode) VALUES ($1,$2,$3,$4,$5) RETURNING *", [id, name, av, img, fc]);
  res.json(r.rows[0]);
}));

// me: profile + friends + invites + my drafts
app.get("/api/me/:id", ah(async (req, res) => {
  const id = req.params.id;
  const u = (await pool.query("SELECT * FROM users WHERE id=$1", [id])).rows[0];
  if (!u) return res.status(404).json({ error: "not found" });
  const friends = (await pool.query(
    `SELECT u.id, u.name, u.av, u.img, u.friendcode FROM friendships f JOIN users u ON u.id=f.b WHERE f.a=$1 ORDER BY u.name`, [id])).rows;
  const invites = (await pool.query(
    `SELECT i.draft_code, i.from_name, d.state->>'name' AS draft_name FROM invites i JOIN drafts d ON d.code=i.draft_code
     WHERE i.to_user=$1 AND (d.state->>'status') = 'lobby' ORDER BY i.created DESC`, [id])).rows;
  const drafts = (await pool.query(
    `SELECT code, state FROM drafts WHERE $1 = ANY(participants) ORDER BY updated DESC LIMIT 25`, [id])).rows
    .map((d) => ({ code: d.code, name: d.state.name, status: d.state.status, sport: d.state.sport,
      rounds: d.state.rounds, seats: d.state.seats.map((s) => ({ name: s.name, av: s.av, img: s.img })),
      turn: d.state.status === "active" ? d.state.seats[pickerIndex(d.state)].name : null,
      archived: (d.state.archivedBy || []).includes(id),
      scoringEnd: d.state.scoring ? d.state.scoring.end : null }));
  res.json({ user: u, friends, invites, drafts });
}));

// add friend by friendcode (mutual)
app.post("/api/friends/add", ah(async (req, res) => {
  const { id, code } = req.body;
  const f = (await pool.query("SELECT id, name, av, img, friendcode FROM users WHERE friendcode=$1", [String(code || "").toUpperCase()])).rows[0];
  if (!f) return res.status(404).json({ error: "No player with that code" });
  if (f.id === id) return res.status(400).json({ error: "That's your own code" });
  await pool.query("INSERT INTO friendships (a,b) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING", [id, f.id]);
  res.json(f);
}));

// create draft (lobby)
app.post("/api/draft/create", ah(async (req, res) => {
  const { hostId, sport, rounds, name } = req.body;
  const u = (await pool.query("SELECT * FROM users WHERE id=$1", [hostId])).rows[0];
  if (!u) return res.status(404).json({ error: "register first" });
  let code;
  for (;;) { code = code6(); const c = await pool.query("SELECT 1 FROM drafts WHERE code=$1", [code]); if (!c.rows.length) break; }
  const state = {
    code, name: String(name || "Squabble").slice(0, 24),
    sport: ["NFL","NBA","MLB","NHL","GOLF","TEN","CBB","CFB"].includes(sport) ? sport : "NFL",
    rounds: [3, 6].includes(+rounds) ? +rounds : 3,
    status: "lobby", hostId,
    seats: [{ userId: hostId, name: u.name, av: u.av, img: u.img, bot: false, roster: [] }],
    picks: [], chat: [],
  };
  await pool.query("INSERT INTO drafts (code, state, participants) VALUES ($1,$2,$3)", [code, state, [hostId]]);
  res.json({ code });
}));

app.get("/api/draft/:code", ah(async (req, res) => {
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [req.params.code.toUpperCase()]);
  if (!r.rows[0]) return res.status(404).json({ error: "Draft not found" });
  res.json(r.rows[0].state);
}));

// join lobby
app.post("/api/draft/:code/join", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId } = req.body;
  const u = (await pool.query("SELECT * FROM users WHERE id=$1", [userId])).rows[0];
  if (!u) return res.status(404).json({ error: "register first" });
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (!st.seats.some((s) => s.userId === userId)) {
    if (st.status !== "lobby") return res.status(400).json({ error: "Draft already started" });
    if (st.seats.length >= 8) return res.status(400).json({ error: "Draft is full (8 max)" });
    st.seats.push({ userId, name: u.name, av: u.av, img: u.img, bot: false, roster: [] });
    await pool.query("UPDATE drafts SET state=$1, participants=array_append(participants,$2), updated=now() WHERE code=$3", [st, userId, code]);
    await pool.query("DELETE FROM invites WHERE draft_code=$1 AND to_user=$2", [code, userId]);
    broadcast(code);
  }
  res.json(st);
}));

// invite a friend
app.post("/api/draft/:code/invite", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { fromId, toUserId } = req.body;
  const from = (await pool.query("SELECT name FROM users WHERE id=$1", [fromId])).rows[0];
  await pool.query("INSERT INTO invites (draft_code, to_user, from_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [code, toUserId, from?.name || "A friend"]);
  res.json({ ok: true });
}));

// host actions
async function hostAction(req, res, fn) {
  const code = req.params.code.toUpperCase();
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (st.hostId !== req.body.hostId) return res.status(403).json({ error: "Only the host can do that" });
  const err = fn(st);
  if (err) return res.status(400).json({ error: err });
  await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [st, code]);
  broadcast(code);
  res.json(st);
}
const BOTNAMES = ["RoboRick", "DraftDroid", "SnakeBot", "AutoAndy", "ChipChip", "BeepBoop", "Circuit Sam"];
app.post("/api/draft/:code/addbot", ah((req, res) => hostAction(req, res, (st) => {
  if (st.status !== "lobby") return "Draft already started";
  if (st.seats.length >= 8) return "Draft is full (8 max)";
  const used = st.seats.map((s) => s.name);
  const name = BOTNAMES.find((b) => !used.includes(b)) || "Bot " + (st.seats.length + 1);
  st.seats.push({ userId: null, name, av: "🤖", img: "", bot: true, roster: [] });
})));
app.post("/api/draft/:code/removeseat", ah((req, res) => hostAction(req, res, (st) => {
  if (st.status !== "lobby") return "Draft already started";
  const i = +req.body.seat;
  if (!st.seats[i] || st.seats[i].userId === st.hostId) return "Can't remove that seat";
  st.seats.splice(i, 1);
})));
app.post("/api/draft/:code/start", ah((req, res) => hostAction(req, res, (st) => {
  if (st.status !== "lobby") return "Already started";
  if (st.seats.length < 2) return "Need at least 2 drafters — invite a friend or add a bot";
  st.status = "active";
})));

app.post("/api/draft/:code/shuffle", ah((req, res) => hostAction(req, res, (st) => {
  if (st.status !== "lobby") return "Draft already started";
  for (let i = st.seats.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [st.seats[i], st.seats[j]] = [st.seats[j], st.seats[i]];
  }
  st.chat.push({ name: "🎲", av: "🎲", img: "", text: "Draft order shuffled! New order: " + st.seats.map((x) => x.name).join(" → "), t: Date.now() });
})));

// leave a lobby draft (non-host removes self; host with no others deletes it)
app.post("/api/draft/:code/leave", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId } = req.body;
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (st.status !== "lobby") return res.status(400).json({ error: "Draft already started" });
  if (st.hostId === userId && st.seats.length <= 1) {
    await pool.query("DELETE FROM drafts WHERE code=$1", [code]);
  } else {
    st.seats = st.seats.filter((s) => s.userId !== userId);
    st.participants = (st.participants || []).filter((id) => id !== userId);
    await pool.query("UPDATE drafts SET state=$1, participants=$2, updated=now() WHERE code=$3", [st, st.participants, code]);
    broadcast(code);
  }
  res.json({ ok: true });
}));

// archive a finished draft (per user)
app.post("/api/draft/:code/archive", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId, undo } = req.body;
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  st.archivedBy = st.archivedBy || [];
  if (undo) st.archivedBy = st.archivedBy.filter((x) => x !== userId);
  else if (!st.archivedBy.includes(userId)) st.archivedBy.push(userId);
  await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [st, code]);
  res.json(st);
}));

// debug: how many rows in player_scores + trigger a fresh poll
app.get("/api/stats/debug", ah(async (req, res) => {
  const count = (await pool.query("SELECT COUNT(*) FROM player_scores")).rows[0].count;
  const recent = (await pool.query("SELECT sport, player, pts, line, day FROM player_scores ORDER BY updated DESC LIMIT 10")).rows;
  scoring.pollAll(pool).catch((e) => console.error("manual poll", e.message));
  res.json({ rows: +count, recent, pollTriggered: true });
}));

// teams playing today for a sport — used to filter draft pool
app.get("/api/schedule/:sport", ah(async (req, res) => {
  const sport = req.params.sport.toUpperCase();
  const teams = await scoring.todaysTeams(sport);
  res.json({ teams: teams ? [...teams] : null });
}));

// debug: show raw ESPN scoreboard events for a sport (e.g. /api/stats/espn/MLB)
app.get("/api/stats/espn/:sport", ah(async (req, res) => {
  const sport = req.params.sport.toUpperCase();
  const LEAGUES = { NFL: ["football","nfl"], CFB: ["football","college-football"], NBA: ["basketball","nba"], CBB: ["basketball","mens-college-basketball"], MLB: ["baseball","mlb"], NHL: ["hockey","nhl"] };
  const pair = LEAGUES[sport];
  if (!pair) return res.status(400).json({ error: "Unknown sport" });
  const today = new Date().toISOString().slice(0,10).replace(/-/g,"");
  const url = `https://site.api.espn.com/apis/site/v2/sports/${pair[0]}/${pair[1]}/scoreboard?dates=${today}`;
  const r = await fetch(url);
  const data = await r.json();
  const events = (data.events || []).map(e => ({ id: e.id, name: e.name, state: e.status?.type?.state, detail: e.status?.type?.detail }));
  res.json({ url, eventCount: events.length, events });
}));

// live scores for a draft (window-summed per player)
app.get("/api/draft/:code/scores", ah(async (req, res) => {
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [req.params.code.toUpperCase()]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  res.json(await scoring.draftScores(pool, st));
}));

app.get("/api/draft/:code/scores/detail", ah(async (req, res) => {
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [req.params.code.toUpperCase()]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  res.json(await scoring.draftScoreDetail(pool, st));
}));

// pick (validated)
app.post("/api/draft/:code/pick", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId, player } = req.body;
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (st.status !== "active") return res.status(400).json({ error: "Draft isn't live" });
  const idx = pickerIndex(st);
  if (st.seats[idx].userId !== userId) return res.status(403).json({ error: "Not your pick" });
  if (st.picks.some((p) => p.player === player)) return res.status(400).json({ error: "Already drafted" });
  const p = PLAYERS.find((x) => x.n === player && (st.sport === "ALL" || x.sp === st.sport));
  if (!p) return res.status(400).json({ error: "Unknown player" });
  applyPick(st, p);
  if (isDone(st)) finishDraft(st);
  await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [st, code]);
  broadcast(code);
  res.json(st);
}));

// chat
app.post("/api/draft/:code/chat", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId, text } = req.body;
  const msg = String(text || "").trim().slice(0, 280);
  if (!msg) return res.status(400).json({ error: "Empty message" });
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  const seat = st.seats.find((s) => s.userId === userId);
  if (!seat) return res.status(403).json({ error: "Join the draft to chat" });
  st.chat.push({ name: seat.name, av: seat.av, img: seat.img, text: msg, t: Date.now() });
  if (st.chat.length > 200) st.chat = st.chat.slice(-200);
  await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [st, code]);
  broadcast(code);
  res.json({ ok: true });
}));

// spa fallback for invite links
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
const SCORE_POLL_MIN = +(process.env.SCORE_POLL_MIN || 5);
initDb().then(() => {
  server.listen(PORT, () => console.log("SquabbleUP live on :" + PORT));
  if (process.env.DEMO_STATS === "on") scoring.seedDemo(pool).catch((e) => console.error("demo seed", e.message));
  if (process.env.SCORING !== "off") {
    scoring.pollAll(pool).catch((e) => console.error("score poll", e.message));
    setInterval(() => scoring.pollAll(pool).catch((e) => console.error("score poll", e.message)), SCORE_POLL_MIN * 60 * 1000);
  }
});
