// SquabbleUP multiplayer server
// env: DATABASE_URL (Neon), PORT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
const express = require("express");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");
const webpush = require("web-push");

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "BCTL-yEHc54ilFkaUMTIAwweXFGanucsmCeSwS9LcJeCnPktpBtdtcNEdjiWUZEvY8Cjbqt5ynwqNDSJSuHp9Mk";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "G1RcF5nesMLPFCo4cQrx-D6tifzPrFGZTi-NWSCKD4A";
webpush.setVapidDetails("mailto:twicebrian@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

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
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      endpoint TEXT NOT NULL,
      subscription JSONB NOT NULL,
      created TIMESTAMPTZ DEFAULT now(),
      UNIQUE (user_id, endpoint)
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_participants ON drafts USING GIN(participants);
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_player_scores_sport_day ON player_scores(sport, day);
    CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(b);
    CREATE INDEX IF NOT EXISTS idx_invites_to_user ON invites(to_user);
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

// Heartbeat: detect dead connections and terminate them
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const url = new URL(req.url, "http://x");
  const code = (url.searchParams.get("draft") || "").toUpperCase();
  if (!code) return ws.close();
  if (!subs.has(code)) subs.set(code, new Set());
  subs.get(code).add(ws);
  ws.on("close", () => subs.get(code)?.delete(ws));
});

const lastNotifiedPick = new Map(); // code -> pick count when last notified

async function broadcast(code) {
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  if (!r.rows[0]) return;
  const st = r.rows[0].state;
  const msg = JSON.stringify({ type: "state", state: st });
  for (const ws of subs.get(code) || []) {
    if (ws.readyState === 1) ws.send(msg);
  }
  scheduleBot(code, st);
  // push notification only when the picker changes (pick count increases)
  if (st.status === "active" && !isDone(st)) {
    const seat = st.seats[pickerIndex(st)];
    if (seat?.userId && !seat.bot) {
      const lastLen = lastNotifiedPick.get(code) ?? -1;
      if (st.picks.length !== lastLen) {
        lastNotifiedPick.set(code, st.picks.length);
        notifyPick(seat.userId, st.name, code).catch(() => {});
      }
    }
  }
}

async function notifyPick(userId, draftName, code) {
  const rows = (await pool.query("SELECT subscription FROM push_subscriptions WHERE user_id=$1", [userId])).rows;
  await Promise.all(rows.map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify({
        title: "Your pick! ⚡",
        body: `It's your turn in ${draftName}`,
        data: { draftCode: code },
      }));
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await pool.query("DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2", [userId, row.subscription.endpoint]);
      }
    }
  }));
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
    const { players: todayNames, roster: todayRoster } = await scoring.todaysSchedule(st.sport).catch(() => ({ players: null, roster: [] }));
    const rankMap = new Map(PLAYERS.map((p) => [p.n, p.r]));
    const playerPool = todayRoster.length > 0 ? todayRoster : PLAYERS.filter((p) => st.sport === "ALL" || p.sp === st.sport);
    const avail = playerPool
      .filter((p) => !taken.has(p.n))
      .filter((p) => st.sport === "ALL" || p.sp === st.sport)
      .filter((p) => !todayNames || todayNames.has(p.n))
      .sort((a, b) => (rankMap.get(a.n) || 999) - (rankMap.get(b.n) || 999))
      .slice(0, 5);
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
const SCORING_DAYS = { NFL: 7, CFB: 7, NBA: 1, CBB: 1, MLB: 1, NHL: 1, GOLF: 4, TEN: 1, UFC: 2, WCUP: 2, SOC: 2 };
function finishDraft(st) {
  st.status = "done";
  const days = SCORING_DAYS[st.sport] || 1;
  st.scoring = { start: Date.now(), end: Date.now() + days * 864e5 };
}

// ---------------- api ----------------
const ah = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "server error" }); });

app.get("/api/push/key", (req, res) => res.json({ key: VAPID_PUBLIC }));
app.post("/api/push/subscribe", ah(async (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription?.endpoint) return res.status(400).json({ error: "bad request" });
  await pool.query(
    "INSERT INTO push_subscriptions (user_id, endpoint, subscription) VALUES ($1,$2,$3) ON CONFLICT (user_id, endpoint) DO UPDATE SET subscription=$3",
    [userId, subscription.endpoint, JSON.stringify(subscription)]
  );
  res.json({ ok: true });
}));

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

// me: profile + friends + invites + my drafts (parallelized)
app.get("/api/me/:id", ah(async (req, res) => {
  const id = req.params.id;
  const [uRes, friendRes, inviteRes, draftRes] = await Promise.all([
    pool.query("SELECT * FROM users WHERE id=$1", [id]),
    pool.query(`SELECT u.id, u.name, u.av, u.img, u.friendcode FROM friendships f JOIN users u ON u.id=f.b WHERE f.a=$1 ORDER BY u.name`, [id]),
    pool.query(`SELECT i.draft_code, i.from_name, d.state->>'name' AS draft_name FROM invites i JOIN drafts d ON d.code=i.draft_code WHERE i.to_user=$1 AND (d.state->>'status') = 'lobby' ORDER BY i.created DESC`, [id]),
    pool.query(`SELECT code, state FROM drafts WHERE $1 = ANY(participants) ORDER BY updated DESC LIMIT 25`, [id]),
  ]);
  const u = uRes.rows[0];
  if (!u) return res.status(404).json({ error: "not found" });
  const drafts = draftRes.rows.map((d) => ({
    code: d.code, name: d.state.name, status: d.state.status, sport: d.state.sport,
    rounds: d.state.rounds, seats: d.state.seats.map((s) => ({ name: s.name, av: s.av, img: s.img })),
    turn: d.state.status === "active" ? d.state.seats[pickerIndex(d.state)].name : null,
    archived: (d.state.archivedBy || []).includes(id),
    scoringEnd: d.state.scoring ? d.state.scoring.end : null,
    handshake: d.state.handshake ? { stake: d.state.handshake.stake } : null,
  }));
  res.json({ user: u, friends: friendRes.rows, invites: inviteRes.rows, drafts });
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

// update own friend code
app.post("/api/user/friendcode", ah(async (req, res) => {
  const { id, newCode } = req.body;
  const nc = String(newCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (nc.length < 3) return res.status(400).json({ error: "Code must be 3–12 letters/numbers" });
  const u = (await pool.query("SELECT id FROM users WHERE id=$1", [id])).rows[0];
  if (!u) return res.status(404).json({ error: "User not found" });
  const taken = (await pool.query("SELECT id FROM users WHERE friendcode=$1 AND id!=$2", [nc, id])).rows[0];
  if (taken) return res.status(409).json({ error: "That code is already taken" });
  await pool.query("UPDATE users SET friendcode=$1 WHERE id=$2", [nc, id]);
  res.json({ friendcode: nc });
}));

// create draft (lobby)
app.post("/api/draft/create", ah(async (req, res) => {
  const { hostId, sport, rounds, name, handshake, public: isPublic } = req.body;
  const u = (await pool.query("SELECT * FROM users WHERE id=$1", [hostId])).rows[0];
  if (!u) return res.status(404).json({ error: "register first" });
  let code;
  for (;;) { code = code6(); const c = await pool.query("SELECT 1 FROM drafts WHERE code=$1", [code]); if (!c.rows.length) break; }
  const state = {
    code, name: String(name || "Squabble").slice(0, 24),
    sport: ["NFL","NBA","MLB","NHL","GOLF","TEN","CBB","CFB","UFC","WCUP","SOC"].includes(sport) ? sport : "NFL",
    rounds: [3, 6].includes(+rounds) ? +rounds : 3,
    status: "lobby", hostId,
    public: isPublic === true,
    createdAt: Date.now(),
    seats: [{ userId: hostId, name: u.name, av: u.av, img: u.img, bot: false, roster: [] }],
    picks: [], chat: [],
    handshake: handshake?.stake ? { stake: String(handshake.stake).slice(0, 60), agreed: [] } : null,
  };
  await pool.query("INSERT INTO drafts (code, state, participants) VALUES ($1,$2,$3)", [code, state, [hostId]]);
  res.json({ code });
}));

// Public lobby — open squabbles anyone can join
app.get("/api/lobby", ah(async (req, res) => {
  const r = await pool.query(
    `SELECT code, state FROM drafts WHERE (state->>'status')='lobby' AND (state->>'public')='true' ORDER BY updated DESC LIMIT 20`
  );
  const rooms = r.rows.map(({ code, state: s }) => ({
    code,
    name: s.name,
    sport: s.sport,
    rounds: s.rounds,
    host: { name: s.seats[0]?.name, av: s.seats[0]?.av },
    seats: s.seats.length,
  }));
  res.json({ rooms });
}));

// Peek at a public lobby room without joining — returns seats + recent chat
app.get("/api/draft/:code/peek", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (!st.public) return res.status(403).json({ error: "Private draft" });
  if (st.status !== "lobby") return res.status(400).json({ error: "Draft already started" });
  res.json({
    code, name: st.name, sport: st.sport, rounds: st.rounds,
    seats: st.seats.map((s) => ({ name: s.name, av: s.av, img: s.img, isHost: s.userId === st.hostId })),
    chat: (st.chat || []).slice(-30),
  });
}));

app.post("/api/draft/:code/handshake", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId } = req.body;
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  if (!r.rows.length) return res.status(404).json({ error: "Draft not found" });
  const st = r.rows[0].state;
  if (!st.handshake) return res.status(400).json({ error: "No handshake on this draft" });
  if (!st.seats.find((s) => s.userId === userId)) return res.status(403).json({ error: "Not in this draft" });
  if (!st.handshake.agreed.includes(userId)) st.handshake.agreed.push(userId);
  await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [JSON.stringify(st), code]);
  broadcast(code);
  res.json({ ok: true });
}));

app.post("/api/draft/:code/recode", ah(async (req, res) => {
  const oldCode = req.params.code.toUpperCase();
  const { hostId, newCode } = req.body;
  const nc = String(newCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (nc.length < 3) return res.status(400).json({ error: "Code must be 3–12 letters/numbers" });
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [oldCode]);
  if (!r.rows.length) return res.status(404).json({ error: "Draft not found" });
  const st = r.rows[0].state;
  if (st.hostId !== hostId) return res.status(403).json({ error: "Host only" });
  if (st.status !== "lobby") return res.status(400).json({ error: "Can only change code in lobby" });
  const exists = await pool.query("SELECT 1 FROM drafts WHERE code=$1", [nc]);
  if (exists.rows.length) return res.status(409).json({ error: "That code is already taken" });
  st.code = nc;
  await pool.query("UPDATE drafts SET code=$1, state=$2 WHERE code=$3", [nc, JSON.stringify(st), oldCode]);
  await pool.query("UPDATE invites SET draft_code=$1 WHERE draft_code=$2", [nc, oldCode]);
  const wsSet = subs.get(oldCode);
  if (wsSet) { subs.set(nc, wsSet); subs.delete(oldCode); }
  res.json({ code: nc });
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
  // FOR UPDATE locks the row so concurrent join requests can't both sneak in a duplicate seat
  const client = await pool.connect();
  let st;
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT state FROM drafts WHERE code=$1 FOR UPDATE", [code]);
    st = r.rows[0]?.state;
    if (!st) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Draft not found" }); }
    if (!st.seats.some((s) => s.userId === userId)) {
      if (st.status !== "lobby") { await client.query("ROLLBACK"); return res.status(400).json({ error: "Draft already started" }); }
      if (st.seats.length >= 8) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Draft is full (8 max)" }); }
      st.seats.push({ userId, name: u.name, av: u.av, img: u.img, bot: false, roster: [] });
      await client.query("UPDATE drafts SET state=$1, participants=array_append(participants,$2), updated=now() WHERE code=$3", [st, userId, code]);
      await client.query("DELETE FROM invites WHERE draft_code=$1 AND to_user=$2", [code, userId]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  broadcast(code);
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
  broadcast(code).catch(console.error);
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
  if (st.handshake) {
    const nonBots = st.seats.filter((s) => !s.bot);
    if (!nonBots.every((s) => st.handshake.agreed.includes(s.userId))) return "Everyone must shake on it before starting";
  }
  if (st.public) {
    shuffleSeats(st);
    st.chat.push({ name: "SquabbleUP", av: "🎲", img: "", text: "Draft order shuffled! " + st.seats.map((x) => x.name).join(" → ") + " — let's squabble UP! 🔥", t: Date.now() });
  }
  st.status = "active";
})));

function shuffleSeats(st) {
  for (let i = st.seats.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [st.seats[i], st.seats[j]] = [st.seats[j], st.seats[i]];
  }
}
app.post("/api/draft/:code/shuffle", ah((req, res) => hostAction(req, res, (st) => {
  if (st.status !== "lobby") return "Draft already started";
  shuffleSeats(st);
  st.chat.push({ name: "Draft Order", av: "🎲", img: "", text: "Order shuffled! " + st.seats.map((x) => x.name).join(" → "), t: Date.now() });
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

// host closes (deletes) a draft — public rooms lobby-only; friends-only rooms any time
app.post("/api/draft/:code/close", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { hostId } = req.body;
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (st.hostId !== hostId) return res.status(403).json({ error: "Only the host can close the room" });
  if (st.public && st.status !== "lobby") return res.status(400).json({ error: "Public drafts cannot be cancelled once started" });
  await pool.query("DELETE FROM drafts WHERE code=$1", [code]);
  broadcast(code);
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

// projected scores for players in a finished draft (matchup view)
app.get("/api/draft/:code/projected", ah(async (req, res) => {
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [req.params.code.toUpperCase()]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  const players = st.seats.flatMap((s) => s.roster.map((p) => p.n));
  const [db, sleeper] = await Promise.all([
    scoring.projectedScores(pool, players),
    scoring.sleeperEnrich(st.sport, players).catch(() => ({ proj: {} })),
  ]);
  res.json({ ...db, ...sleeper.proj });
}));

// teams playing today for a sport — used to filter draft pool
app.get("/api/schedule/:sport", ah(async (req, res) => {
  const sport = req.params.sport.toUpperCase();
  const { players, matchups, roster } = await scoring.todaysSchedule(sport);
  const nextDay = players ? null : await scoring.nextGameDay(sport);
  res.json({ players: players ? [...players] : null, matchups, roster: roster || [], nextDay });
}));

app.get("/api/projected/:sport", ah(async (req, res) => {
  const sport = req.params.sport.toUpperCase();
  // use today's live roster so projections cover every draftable player, not just our static list
  const { roster } = await scoring.todaysSchedule(sport).catch(() => ({ roster: [] }));
  const sportPlayers = roster.length > 0
    ? roster.map((p) => p.n)
    : PLAYERS.filter((p) => p.sp === sport).map((p) => p.n);
  if (!sportPlayers.length) return res.json({ proj: {}, status: {} });
  const [dbProj, sleeper] = await Promise.all([
    scoring.projectedScores(pool, sportPlayers),
    scoring.sleeperEnrich(sport, sportPlayers).catch(() => ({ proj: {}, status: {} })),
  ]);
  const proj = { ...dbProj, ...sleeper.proj };
  res.json({ proj, status: sleeper.status });
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
  const { userId, player, pos, sp, tm } = req.body;
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (st.status !== "active") return res.status(400).json({ error: "Draft isn't live" });
  const idx = pickerIndex(st);
  if (st.seats[idx].userId !== userId) return res.status(403).json({ error: "Not your pick" });
  if (st.picks.some((p) => p.player === player)) return res.status(400).json({ error: "Already drafted" });
  // look up in static PLAYERS first; fall back to metadata sent by client (live ESPN roster players)
  let p = PLAYERS.find((x) => x.n === player && (st.sport === "ALL" || x.sp === st.sport));
  if (!p && pos && sp && tm && (st.sport === "ALL" || sp === st.sport)) p = { n: player, pos, sp, tm };
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

// admin: force-delete any stuck draft by code (secured by ADMIN_KEY env var)
app.delete("/api/admin/draft/:code", ah(async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const code = req.params.code.toUpperCase();
  await pool.query("DELETE FROM drafts WHERE code=$1", [code]);
  broadcast(code);
  res.json({ ok: true, deleted: code });
}));

// spa fallback for invite links
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
const SCORE_POLL_MIN = +(process.env.SCORE_POLL_MIN || 5);
// Auto-close public lobby rooms that haven't started within 20 minutes.
// Uses createdAt from state when present, falls back to DB updated column.
async function cleanupStaleLobbies() {
  try {
    const r = await pool.query(
      `SELECT code FROM drafts
       WHERE (state->>'status') = 'lobby'
       AND (state->>'public') = 'true'
       AND (
         ((state->>'createdAt') IS NOT NULL AND (state->>'createdAt')::bigint < $1)
         OR ((state->>'createdAt') IS NULL AND updated < now() - interval '20 minutes')
       )`,
      [Date.now() - 20 * 60 * 1000]
    );
    for (const row of r.rows) {
      await pool.query("DELETE FROM drafts WHERE code=$1", [row.code]);
      broadcast(row.code);
      console.log("Auto-closed expired public lobby:", row.code);
    }
  } catch (e) { console.error("lobby cleanup", e.message); }
}

initDb().then(() => {
  server.listen(PORT, () => console.log("SquabbleUP live on :" + PORT));
  if (process.env.DEMO_STATS === "on") scoring.seedDemo(pool).catch((e) => console.error("demo seed", e.message));
  if (process.env.SCORING !== "off") {
    scoring.pollAll(pool).catch((e) => console.error("score poll", e.message));
    setInterval(() => scoring.pollAll(pool).catch((e) => console.error("score poll", e.message)), SCORE_POLL_MIN * 60 * 1000);
  }
  cleanupStaleLobbies();
  setInterval(cleanupStaleLobbies, 60 * 1000);
});
