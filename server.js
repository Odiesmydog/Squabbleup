// SquabbleUP multiplayer server
// env: DATABASE_URL (Neon), PORT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
const express = require("express");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const compression = require("compression");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");
const webpush = require("web-push");

// Never let one unhandled error take down every live draft — log and keep serving.
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e?.message || e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e?.stack || e));

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "BCTL-yEHc54ilFkaUMTIAwweXFGanucsmCeSwS9LcJeCnPktpBtdtcNEdjiWUZEvY8Cjbqt5ynwqNDSJSuHp9Mk";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "G1RcF5nesMLPFCo4cQrx-D6tifzPrFGZTi-NWSCKD4A";
webpush.setVapidDetails("mailto:twicebrian@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);

const app = express();
app.use(compression()); // gzip — index.html + players-data.js shrink ~75%
app.use(express.json({ limit: "200kb" }));

// Simple per-IP rate limit so one runaway client can't starve everyone else.
// In-memory is fine: the app is single-instance by design (ws subs live in memory).
const _rl = new Map(); // ip -> { n, t }
const RL_WINDOW = 30_000, RL_MAX = 300; // 300 req / 30s ≈ 10 rps sustained per IP
app.use("/api/", (req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  const now = Date.now();
  let e = _rl.get(ip);
  if (!e || now - e.t > RL_WINDOW) { e = { n: 0, t: now }; _rl.set(ip, e); }
  if (++e.n > RL_MAX) return res.status(429).json({ error: "Slow down — too many requests" });
  next();
});
setInterval(() => { const now = Date.now(); for (const [ip, e] of _rl) if (now - e.t > RL_WINDOW * 2) _rl.delete(ip); }, 60_000);

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, p) => {
    // HTML + service worker must revalidate; versioned assets (?v=N) can cache long
    if (p.endsWith(".html") || p.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
    else res.setHeader("Cache-Control", "public, max-age=86400");
  },
}));

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
      first_scored_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (day, sport, player)
    );
    ALTER TABLE player_scores ADD COLUMN IF NOT EXISTS first_scored_at TIMESTAMPTZ DEFAULT now();
    ALTER TABLE users ADD COLUMN IF NOT EXISTS premium BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS squabbles_used INT NOT NULL DEFAULT 0;
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
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      val BIGINT NOT NULL DEFAULT 0
    );
    INSERT INTO stats (key, val) VALUES ('drafts_created', 0) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS pools (
      code TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      participants UUID[] DEFAULT '{}',
      updated TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pool_invites (
      id BIGSERIAL PRIMARY KEY,
      pool_code TEXT NOT NULL, to_user UUID NOT NULL,
      from_name TEXT, created TIMESTAMPTZ DEFAULT now(),
      UNIQUE (pool_code, to_user)
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_participants ON drafts USING GIN(participants);
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts ((state->>'status'));
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_player_scores_sport_day ON player_scores(sport, day);
    CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(b);
    CREATE INDEX IF NOT EXISTS idx_invites_to_user ON invites(to_user);
    CREATE INDEX IF NOT EXISTS idx_pools_participants ON pools USING GIN(participants);
    CREATE INDEX IF NOT EXISTS idx_pool_invites_to_user ON pool_invites(to_user);
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
const pendingPickNotify = new Map(); // code -> setTimeout handle (cancel if next pick arrives fast)

async function broadcast(code) {
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  if (!r.rows[0]) return;
  const st = r.rows[0].state;
  const msg = JSON.stringify({ type: "state", state: st });
  for (const ws of subs.get(code) || []) {
    if (ws.readyState === 1) ws.send(msg);
  }
  scheduleBot(code, st);
  // push notification when the picker changes — delayed 3s so the UI updates first
  // and the SW can suppress if the user's app is already focused
  if (st.status === "active" && !isDone(st)) {
    const seat = st.seats[pickerIndex(st)];
    if (seat?.userId && !seat.bot && !seat.autoDraft) {
      const lastLen = lastNotifiedPick.get(code) ?? -1;
      if (st.picks.length !== lastLen) {
        lastNotifiedPick.set(code, st.picks.length);
        // cancel any pending notification for the previous turn (picked before 3s elapsed)
        if (pendingPickNotify.has(code)) clearTimeout(pendingPickNotify.get(code));
        const t = setTimeout(() => {
          pendingPickNotify.delete(code);
          notifyPick(seat.userId, st.name, code).catch(() => {});
        }, 3000);
        pendingPickNotify.set(code, t);
      }
    }
  }
}

// Tell connected clients the draft no longer exists, then drop their subscriptions.
// Must be used instead of broadcast() when deleting: broadcast reads the DB row,
// finds nothing after a DELETE, and silently does nothing.
function broadcastDeleted(code) {
  const msg = JSON.stringify({ type: "deleted" });
  for (const ws of subs.get(code) || []) {
    if (ws.readyState === 1) ws.send(msg);
  }
  subs.delete(code);
  lastNotifiedPick.delete(code);
  if (pendingPickNotify.has(code)) { clearTimeout(pendingPickNotify.get(code)); pendingPickNotify.delete(code); }
}

// shared by notifyPick/notifyDraftStart/survivor-pool reminders — sends to every
// subscription a user has registered, pruning any that the push service reports gone
async function sendPush(userId, payload) {
  const rows = (await pool.query("SELECT subscription FROM push_subscriptions WHERE user_id=$1", [userId])).rows;
  await Promise.all(rows.map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await pool.query("DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2", [userId, row.subscription.endpoint]);
      }
    }
  }));
}

async function notifyPick(userId, draftName, code) {
  await sendPush(userId, { title: "Your pick! ⚡", body: `It's your turn in ${draftName}`, data: { draftCode: code } });
}

async function notifyDraftStart(st, code) {
  const userIds = st.seats.filter((s) => s.userId).map((s) => s.userId);
  const sportEmoji = { NFL:"🏈",NBA:"🏀",MLB:"⚾",NHL:"🏒",GOLF:"⛳",TEN:"🎾",CBB:"🏀",CFB:"🏈",UFC:"🥊",WCUP:"🌍",SOC:"⚽" };
  const em = sportEmoji[st.sport] || "🔥";
  await Promise.all(userIds.map((userId) => sendPush(userId, {
    title: `${st.name} is starting! ${em}`,
    body: "Draft begins in 45 seconds — get ready to squabble UP! 🔥",
    data: { draftCode: code },
  })));
}


// ---------------- bot picks (server-side) ----------------
const PLAYERS = require("./public/players-data.js");
const scoring = require("./scoring.js");

// Resolves a sport's full schedule, preferring the week-spanning view for NFL/CFB so a
// multi-day draft (built from the wizard's week picker) sees every game it could have been
// scoped to, not just "today's" one. No gameFilter applied — see resolveDraftPool for that.
async function scheduleFor(sport) {
  return scoring.WEEK_SLATE_SPORTS.has(sport)
    ? await scoring.weekSchedule(sport).catch(() => null)
    : await scoring.todaysSchedule(sport).catch(() => null);
}
// scheduleFor(), narrowed to a draft's optional gameFilter. Used by bot auto-pick and
// pick-timer-expiry auto-pick, where there's no user to show a specific error to — they
// just need a correctly-scoped pool. Pick validation calls scheduleFor() directly instead
// so it can report *why* a pick failed ("wasn't included in this draft" vs "isn't playing").
async function resolveDraftPool(sport, gameFilter) {
  const sched = await scheduleFor(sport);
  if (!sched) return { players: null, roster: [] };
  let roster = sched.roster || [];
  if (gameFilter) {
    const key = scoring.INDIVIDUAL_SPORTS.has(sport) ? "n" : "tm";
    roster = roster.filter((p) => gameFilter.includes(p[key]));
  }
  const players = gameFilter ? new Set(roster.map((p) => p.n)) : sched.players;
  return { players, roster };
}

// Rank-based fallback projections for sports without Sleeper coverage.
// Uses each player's static rank to estimate a realistic fantasy point range.
const RANK_PROJ_RANGE = {
  NFL: [32, 4], NBA: [52, 12], MLB: [18, 2], NHL: [18, 2], CFB: [28, 4], CBB: [38, 8],
  UFC: [16, 5], GOLF: [22, 3], TEN: [18, 0], SOC: [10, 1], WCUP: [10, 1],
};
function rankProj(rank, sport) {
  const [top, bot] = RANK_PROJ_RANGE[sport] || [15, 2];
  const r = Math.min(Math.max(rank || 100, 1), 200);
  return Math.round((top - (top - bot) * (r - 1) / 199) * 10) / 10;
}
const _rankMap = new Map(PLAYERS.map((p) => [p.n, { r: p.r, sp: p.sp }]));
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
    const { players: todayNames, roster: todayRoster } = await resolveDraftPool(st.sport, st.gameFilter);
    const rankMap = new Map(PLAYERS.map((p) => [p.n, p.r]));
    const playerPool = todayRoster.length > 0 ? todayRoster : PLAYERS.filter((p) => st.sport === "ALL" || p.sp === st.sport);
    const avail = playerPool
      .filter((p) => !taken.has(p.n))
      .filter((p) => st.sport === "ALL" || p.sp === st.sport)
      .filter((p) => !todayNames || todayNames.has(p.n))
      .filter((p) => !p.livelock)
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
  // Always stamp when the new turn began — not just when a pick timer is set. Used by the
  // pick-timer countdown (when one exists) and by serverAutoDraft's Auto Draft grace period
  // (every draft). Previously this was only set on manual/serverAutoDraft picks, never on bot
  // picks — after a bot picked, the next human's turn inherited a stale, already-"expired"
  // timestamp, so a timed draft could auto-draft a present, actively-clicking player's very
  // next turn before they got a chance to act.
  st.pickStartedAt = Date.now();
}
// UFC gets 8 days: off-day drafts pull the NEXT card (up to a week out), so the
// window must stay open long enough to cover it. Pre-draft scores can't leak in
// anyway (first_scored_at guard in scoring.js).
const SCORING_DAYS = { NFL: 7, CFB: 7, NBA: 1, CBB: 1, MLB: 1, NHL: 1, GOLF: 7, TEN: 2, UFC: 8, WCUP: 2, SOC: 2 };
function finishDraft(st) {
  st.status = "done";
  if (st.sport === "GOLF") {
    // close scoring Monday 6am UTC so it covers the full Thu–Sun tournament week
    const now = new Date();
    const daysUntilMon = (8 - now.getUTCDay()) % 7 || 7;
    const endMon = new Date(now);
    endMon.setUTCDate(now.getUTCDate() + daysUntilMon);
    endMon.setUTCHours(6, 0, 0, 0);
    st.scoring = { start: Date.now(), end: endMon.getTime() };
  } else {
    const days = SCORING_DAYS[st.sport] || 1;
    st.scoring = { start: Date.now(), end: Date.now() + days * 864e5 };
  }
}

// ---------------- api ----------------
const ah = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "server error" }); });

// Micro-cache for endpoints every home-screen client polls. At 1,000 concurrent
// users this turns ~100 identical queries/sec into one query per 5 seconds.
const _microCache = new Map(); // key -> { t, data }
async function cached(key, ttlMs, fn) {
  const hit = _microCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  const data = await fn();
  _microCache.set(key, { t: Date.now(), data });
  return data;
}

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
  const [uRes, friendRes, inviteRes, draftRes, poolRes, poolInviteRes] = await Promise.all([
    pool.query("SELECT * FROM users WHERE id=$1", [id]),
    pool.query(`SELECT u.id, u.name, u.av, u.img, u.friendcode FROM friendships f JOIN users u ON u.id=f.b WHERE f.a=$1 ORDER BY u.name`, [id]),
    pool.query(`SELECT i.draft_code, i.from_name, d.state->>'name' AS draft_name FROM invites i JOIN drafts d ON d.code=i.draft_code WHERE i.to_user=$1 AND (d.state->>'status') = 'lobby' ORDER BY i.created DESC`, [id]),
    pool.query(`SELECT code, state FROM drafts WHERE $1 = ANY(participants) ORDER BY updated DESC LIMIT 25`, [id]),
    pool.query(`SELECT code, state FROM pools WHERE $1 = ANY(participants) ORDER BY updated DESC LIMIT 25`, [id]),
    pool.query(`SELECT pi.pool_code, pi.from_name, p.state->>'name' AS pool_name FROM pool_invites pi JOIN pools p ON p.code=pi.pool_code WHERE pi.to_user=$1 AND (p.state->>'status')='open' ORDER BY pi.created DESC`, [id]),
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
  const pools = poolRes.rows.map((p) => {
    const st = p.state;
    const mine = st.entries.find((e) => e.userId === id);
    const alive = st.entries.filter((e) => e.alive);
    return {
      code: p.code, name: st.name, status: st.status, hostId: st.hostId,
      myAlive: mine ? mine.alive : null, myEliminatedWeek: mine ? mine.eliminatedWeek : null,
      weekKey: st.week.key, deadline: st.week.deadline, weekLocked: st.week.locked,
      aliveCount: alive.length, entryCount: st.entries.length,
      handshake: st.handshake ? { stake: st.handshake.stake } : null,
      winners: st.winners,
    };
  });
  res.json({ user: u, friends: friendRes.rows, invites: inviteRes.rows, drafts, pools, poolInvites: poolInviteRes.rows });
}));

// add friend by friendcode (mutual)
app.post("/api/friends/add", ah(async (req, res) => {
  const { id, code } = req.body;
  const u = (await pool.query("SELECT id FROM users WHERE id=$1", [id])).rows[0];
  if (!u) return res.status(404).json({ error: "register first" });
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

// Account deletion — required by App Store guideline 5.1.1(v) for apps with accounts.
// Removes the user and their personal data; their name/avatar stays on finished draft
// boards (like a forum post) but is no longer linked to an account.
app.post("/api/account/delete", ah(async (req, res) => {
  const { userId } = req.body;
  const u = (await pool.query("SELECT id FROM users WHERE id=$1", [userId])).rows[0];
  if (!u) return res.status(404).json({ error: "Account not found" });
  await pool.query("DELETE FROM friendships WHERE a=$1 OR b=$1", [userId]);
  await pool.query("DELETE FROM push_subscriptions WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM invites WHERE to_user=$1", [userId]);
  await pool.query("UPDATE drafts SET participants = array_remove(participants, $1)", [userId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  res.json({ ok: true });
}));

// create draft (lobby)
app.post("/api/draft/create", ah(async (req, res) => {
  const { hostId, sport, rounds, name, handshake, public: isPublic, gameFilter } = req.body;
  const u = (await pool.query("SELECT * FROM users WHERE id=$1", [hostId])).rows[0];
  if (!u) return res.status(404).json({ error: "register first" });
  // Golf has no per-team roster to fall back on like other sports — when ESPN hasn't
  // published the tournament field yet, the only "pool" would be a handful of notable
  // names with no guarantee they're even entered in the next event. Block instead of
  // letting people draft players who might score zero because they're not playing at all.
  if (sport === "GOLF") {
    const sched = await scoring.todaysSchedule("GOLF").catch(() => null);
    if (!sched?.players) {
      const next = await scoring.nextGameDay("GOLF").catch(() => null);
      return res.status(400).json({ error: next ? `No golf field published yet — check back closer to ${next}` : "No upcoming golf tournament found right now" });
    }
  }
  let code;
  for (;;) { code = code6(); const c = await pool.query("SELECT 1 FROM drafts WHERE code=$1", [code]); if (!c.rows.length) break; }
  const { pickTimer: rawTimer } = req.body;
  const pickTimer = [0, 30, 60, 90, 120, 180, 300].includes(+rawTimer) ? +rawTimer : 0;
  const normSport = ["NFL","NBA","MLB","NHL","GOLF","TEN","CBB","CFB","UFC","WCUP","SOC"].includes(sport) ? sport : "NFL";
  // scopes the draftable pool to specific games (e.g. one CFB Saturday has 60+ games).
  // Team-based sports: array of team abbreviations. UFC/tennis (INDIVIDUAL_SPORTS, no
  // shared team): array of player names instead — don't force-case or over-truncate those.
  const gameFilterClean = Array.isArray(gameFilter) && gameFilter.length > 0
    ? gameFilter.filter((t) => typeof t === "string" && t.length > 0)
        .map((t) => scoring.INDIVIDUAL_SPORTS.has(normSport) ? t.slice(0, 80) : t.toUpperCase().slice(0, 6))
        .slice(0, 128)
    : null;
  const state = {
    code, name: String(name || "Squabble").slice(0, 24),
    sport: normSport,
    rounds: [3, 6].includes(+rounds) ? +rounds : 3,
    status: "lobby", hostId,
    public: isPublic === true,
    pickTimer,
    createdAt: Date.now(),
    seats: [{ userId: hostId, name: u.name, av: u.av, img: u.img, bot: false, roster: [] }],
    picks: [], chat: [],
    handshake: handshake?.stake ? { stake: String(handshake.stake).slice(0, 60), agreed: [] } : null,
    gameFilter: gameFilterClean,
  };
  await pool.query("INSERT INTO drafts (code, state, participants) VALUES ($1,$2,$3)", [code, state, [hostId]]);
  pool.query("UPDATE stats SET val = val + 1 WHERE key='drafts_created'").catch(() => {});
  res.json({ code });
}));

// Save a completed pass-and-play draft to the server so it gets real scoring
app.post("/api/draft/save-local", ah(async (req, res) => {
  const { draft: ld } = req.body;
  const VALID_SPORTS = ["NFL","NBA","MLB","NHL","GOLF","TEN","CBB","CFB","UFC","WCUP","SOC"];
  if (!ld?.seats?.length || !ld?.picks?.length || !VALID_SPORTS.includes(ld.sport)) {
    return res.status(400).json({ error: "Invalid draft" });
  }
  let code;
  for (;;) { code = code6(); const c = await pool.query("SELECT 1 FROM drafts WHERE code=$1", [code]); if (!c.rows.length) break; }
  const st = {
    code,
    name: String(ld.name || "Pass & play squabble").slice(0, 24),
    sport: ld.sport, rounds: ld.rounds || 3,
    hostId: null, public: false, local: true,
    seats: ld.seats, picks: ld.picks, chat: [],
    createdAt: Date.now(),
  };
  finishDraft(st);
  await pool.query("INSERT INTO drafts (code, state, participants) VALUES ($1,$2,$3)", [code, JSON.stringify(st), []]);
  pool.query("UPDATE stats SET val = val + 1 WHERE key='drafts_created'").catch(() => {});
  res.json({ code, scoring: st.scoring });
}));

// Public stats — total squabbles ever created (5s micro-cache)
app.get("/api/stats", ah(async (req, res) => {
  const out = await cached("stats", 5000, async () => {
    const r = await pool.query("SELECT val FROM stats WHERE key='drafts_created'");
    return { draftsCreated: parseInt(r.rows[0]?.val || 0) };
  });
  res.json(out);
}));

// Public lobby — open squabbles anyone can join (5s micro-cache)
app.get("/api/lobby", ah(async (req, res) => {
  const out = await cached("lobby", 5000, async () => {
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
    return { rooms };
  });
  res.json(out);
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

// shared by draft + survivor-pool handshake agree endpoints — `table` is always a
// hardcoded literal from our own code, never user input
async function agreeHandshake(table, code, userId) {
  const r = await pool.query(`SELECT state FROM ${table} WHERE code=$1`, [code]);
  const noun = table === "pools" ? "pool" : "draft";
  if (!r.rows.length) return { error: 404, msg: `${noun[0].toUpperCase()}${noun.slice(1)} not found` };
  const st = r.rows[0].state;
  const members = table === "pools" ? st.entries : st.seats;
  if (!st.handshake) return { error: 400, msg: `No handshake on this ${noun}` };
  if (!members.find((m) => m.userId === userId)) return { error: 403, msg: `Not in this ${noun}` };
  if (!st.handshake.agreed.includes(userId)) st.handshake.agreed.push(userId);
  await pool.query(`UPDATE ${table} SET state=$1, updated=now() WHERE code=$2`, [JSON.stringify(st), code]);
  return { st };
}

app.post("/api/draft/:code/handshake", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId } = req.body;
  const result = await agreeHandshake("drafts", code, userId);
  if (result.error) return res.status(result.error).json({ error: result.msg });
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
      const nameTaken = st.seats.some((s) => s.name.trim().toLowerCase() === u.name.trim().toLowerCase());
      if (nameTaken) { await client.query("ROLLBACK"); return res.status(409).json({ error: `The name "${u.name}" is already taken in this draft — update your profile name and try again` }); }
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
  // keep participants in sync with seats so kicked users don't keep the draft in their lists
  const parts = st.seats.map((s) => s.userId).filter(Boolean);
  await pool.query("UPDATE drafts SET state=$1, participants=$2, updated=now() WHERE code=$3", [st, parts, code]);
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
const COUNTDOWN_MS = 45 * 1000; // 45-second warm-up before picks begin
app.post("/api/draft/:code/start", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (st.hostId !== req.body.hostId) return res.status(403).json({ error: "Only the host can do that" });
  if (st.status !== "lobby") return res.status(400).json({ error: "Already started" });
  if (st.seats.length < 2) return res.status(400).json({ error: "Need at least 2 drafters — invite a friend or add a bot" });
  if (st.handshake) {
    const nonBots = st.seats.filter((s) => !s.bot);
    if (!nonBots.every((s) => st.handshake.agreed.includes(s.userId))) return res.status(400).json({ error: "Everyone must shake on it before starting" });
  }
  // shuffle now so clients see the final order during the countdown
  if (st.public) {
    shuffleSeats(st);
    st.chat.push({ name: "SquabbleUP", av: "🎲", img: "", text: "Draft order shuffled! " + st.seats.map((x) => x.name).join(" → ") + " — let's squabble UP! 🔥", t: Date.now() });
  }
  // countdown phase: keep status "lobby" with startingAt so all clients show timer
  st.startingAt = Date.now() + COUNTDOWN_MS;
  await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [st, code]);
  broadcast(code).catch(console.error);
  notifyDraftStart(st, code).catch(() => {}); // push: "starting in 45s"
  res.json(st);
  // flip to active after countdown — atomic WHERE prevents the 5s poller from double-firing
  setTimeout(() => activateCountdown(code), COUNTDOWN_MS);
}));

// Atomically flip a countdown lobby to active — safe to call from both setTimeout and the 5s poller.
// The WHERE clause ensures only the first caller wins; the second is a no-op (0 rows updated).
async function activateCountdown(code) {
  try {
    const r = await pool.query(
      `UPDATE drafts
       SET state = (state - 'startingAt') || '{"status":"active"}'::jsonb, updated = now()
       WHERE code = $1
         AND (state->>'status') = 'lobby'
         AND (state->>'startingAt') IS NOT NULL
       RETURNING state`,
      [code]
    );
    if (!r.rows[0]) return; // already activated or draft gone
    const st = r.rows[0].state;
    st.pickStartedAt = Date.now();
    await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [st, code]);
    broadcast(code).catch(console.error);
    console.log("Countdown-activated draft:", code);
  } catch (e) { console.error("activateCountdown", e.message); }
}

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

// leave a lobby draft (non-host removes self; host hands off to another human, or the room closes)
app.post("/api/draft/:code/leave", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId } = req.body;
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  if (st.status !== "lobby") return res.status(400).json({ error: "Draft already started" });
  st.seats = st.seats.filter((s) => s.userId !== userId);
  const remainingHumans = st.seats.filter((s) => s.userId);
  if (st.hostId === userId) {
    if (!remainingHumans.length) {
      // no humans left — close the room entirely
      await pool.query("DELETE FROM drafts WHERE code=$1", [code]);
      broadcastDeleted(code);
      return res.json({ ok: true });
    }
    st.hostId = remainingHumans[0].userId; // hand host to the next human so the room isn't orphaned
    st.chat.push({ name: "SquabbleUP", av: "👑", img: "", text: `${remainingHumans[0].name} is now the host`, t: Date.now() });
  }
  await pool.query("UPDATE drafts SET state=$1, participants=array_remove(participants,$2), updated=now() WHERE code=$3", [st, userId, code]);
  broadcast(code);
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
  broadcastDeleted(code);
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
  const proj = { ...db, ...sleeper.proj };
  for (const name of players) {
    if (!proj[name]) { const pd = _rankMap.get(name); if (pd) proj[name] = { proj: rankProj(pd.r, pd.sp) }; }
  }
  res.json(proj);
}));

// teams playing today for a sport — used to filter draft pool
app.get("/api/schedule/:sport", ah(async (req, res) => {
  const sport = req.params.sport.toUpperCase();
  const { players, matchups, roster, futureDate } = await scoring.todaysSchedule(sport);
  const nextDay = players ? null : await scoring.nextGameDay(sport);
  res.json({ players: players ? [...players] : null, matchups, roster: roster || [], nextDay, futureDate: futureDate || null });
}));

// whole week's games for weekly-cadence sports (NFL/CFB) — lets a host build one draft
// spanning multiple game days instead of just the next single day. See scoring.js for why
// this isn't offered for daily-cadence sports (MLB/NBA/NHL).
app.get("/api/schedule/:sport/week", ah(async (req, res) => {
  const sport = req.params.sport.toUpperCase();
  const week = await scoring.weekSchedule(sport);
  if (!week) return res.status(400).json({ error: "Week view isn't available for this sport" });
  res.json({ days: week.days, matchups: week.matchups, roster: week.roster, players: week.players ? [...week.players] : null });
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
  for (const name of sportPlayers) {
    if (!proj[name]) { const pd = _rankMap.get(name); if (pd) proj[name] = { proj: rankProj(pd.r, pd.sp), source: "rank" }; }
  }
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

// toggle a seat's auto-pick preference — persisted so the server can skip "your pick!"
// push notifications for turns the client is about to fill in automatically anyway
app.post("/api/draft/:code/autodraft", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId, on } = req.body;
  const r = await pool.query("SELECT state FROM drafts WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Draft not found" });
  const seat = st.seats.find((s) => s.userId === userId);
  if (!seat) return res.status(403).json({ error: "Not in this draft" });
  seat.autoDraft = !!on;
  await pool.query("UPDATE drafts SET state=$1, updated=now() WHERE code=$2", [st, code]);
  res.json({ ok: true });
}));

// pick (validated, optimistic concurrency: write only if pick count unchanged)
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
  // Server-side eligibility check — clients hide ineligible players, but their
  // schedule can be a couple of minutes stale (or hostile). Never trust it.
  const sched = await scheduleFor(st.sport);
  if (sched?.players) {
    if (!sched.players.has(player))
      return res.status(400).json({ error: `${player} isn't playing today — the list just refreshed` });
    const rp = (sched.roster || []).find((x) => x.n === player);
    if (rp?.livelock)
      return res.status(400).json({ error: `${player} already started playing — pick someone whose game hasn't begun` });
    const filterKey = scoring.INDIVIDUAL_SPORTS.has(st.sport) ? player : rp?.tm;
    if (st.gameFilter && filterKey && !st.gameFilter.includes(filterKey))
      return res.status(400).json({ error: `${player}'s game wasn't included in this draft` });
  }
  let p = PLAYERS.find((x) => x.n === player && (st.sport === "ALL" || x.sp === st.sport));
  if (!p && pos && sp && tm && (st.sport === "ALL" || sp === st.sport)) p = { n: player, pos, sp, tm };
  if (!p) return res.status(400).json({ error: "Unknown player" });
  const prevLen = st.picks.length;
  applyPick(st, p);
  if (isDone(st)) {
    finishDraft(st);
    lastNotifiedPick.delete(code);
    if (pendingPickNotify.has(code)) { clearTimeout(pendingPickNotify.get(code)); pendingPickNotify.delete(code); }
  }
  // optimistic update: only write if no concurrent pick snuck in
  const upd = await pool.query(
    "UPDATE drafts SET state=$1, updated=now() WHERE code=$2 AND jsonb_array_length(state->'picks')=$3",
    [st, code, prevLen]
  );
  if (upd.rowCount === 0) return res.status(409).json({ error: "Pick conflict — please try again" });
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
  broadcastDeleted(code);
  res.json({ ok: true, deleted: code });
}));

// ---------------- survivor pools ----------------
// Redacts other entrants' current-week pick until the week locks — everyone sees
// identical, fair data at the same moment (same ethos as the shared-scoring design).
function poolSafeState(st, viewerId) {
  const revealed = st.week.locked;
  return {
    code: st.code, name: st.name, hostId: st.hostId, status: st.status,
    handshake: st.handshake ? { stake: st.handshake.stake, agreed: st.handshake.agreed } : null,
    winners: st.winners,
    week: { key: st.week.key, deadline: st.week.deadline, games: st.week.games, locked: st.week.locked },
    entries: st.entries.map((e) => {
      const curPick = e.picks.find((p) => p.weekKey === st.week.key);
      const isSelf = e.userId === viewerId;
      return {
        userId: e.userId, name: e.name, av: e.av, img: e.img,
        alive: e.alive, eliminatedWeek: e.eliminatedWeek, usedTeams: e.usedTeams,
        hasPickedThisWeek: !!curPick,
        currentPick: (revealed || isSelf) ? (curPick ? { team: curPick.team, result: curPick.result } : null) : undefined,
        pastPicks: e.picks.filter((p) => p.weekKey !== st.week.key),
      };
    }),
  };
}

app.post("/api/pool/create", ah(async (req, res) => {
  const { hostId, name, handshake } = req.body;
  const u = (await pool.query("SELECT * FROM users WHERE id=$1", [hostId])).rows[0];
  if (!u) return res.status(404).json({ error: "register first" });
  const live = await scoring.survivorWeek("NFL").catch(() => null);
  if (!live) return res.status(503).json({ error: "Couldn't reach the NFL schedule — try again in a moment" });
  const pre = live.games.filter((g) => g.state === "pre");
  if (!pre.length) return res.status(400).json({ error: "No upcoming NFL games this week — check back once next week's schedule is out" });
  let code;
  for (;;) { code = code6(); const c = await pool.query("SELECT 1 FROM pools WHERE code=$1", [code]); if (!c.rows.length) break; }
  const state = {
    code, name: String(name || "Survivor Pool").slice(0, 24), hostId,
    status: "open",
    createdAt: Date.now(),
    handshake: handshake?.stake ? { stake: String(handshake.stake).slice(0, 60), agreed: [] } : null,
    entries: [{ userId: hostId, name: u.name, av: u.av, img: u.img, alive: true, eliminatedWeek: null, usedTeams: [], picks: [] }],
    week: {
      key: live.weekKey, deadline: Math.min(...pre.map((g) => g.kickoff)),
      games: pre, remindersSent: { "24h": false, "3h": false }, locked: false, eliminationsProcessed: false,
    },
    winners: null,
  };
  await pool.query("INSERT INTO pools (code, state, participants) VALUES ($1,$2,$3)", [code, state, [hostId]]);
  res.json({ code });
}));

app.get("/api/pool/:code", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r = await pool.query("SELECT state FROM pools WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Pool not found" });
  res.json(poolSafeState(st, req.query.userId));
}));

app.post("/api/pool/:code/join", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId } = req.body;
  const u = (await pool.query("SELECT * FROM users WHERE id=$1", [userId])).rows[0];
  if (!u) return res.status(404).json({ error: "register first" });
  const client = await pool.connect();
  let st;
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT state FROM pools WHERE code=$1 FOR UPDATE", [code]);
    st = r.rows[0]?.state;
    if (!st) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Pool not found" }); }
    if (!st.entries.some((e) => e.userId === userId)) {
      if (st.status !== "open") { await client.query("ROLLBACK"); return res.status(400).json({ error: "Entries are closed — this pool already started" }); }
      st.entries.push({ userId, name: u.name, av: u.av, img: u.img, alive: true, eliminatedWeek: null, usedTeams: [], picks: [] });
      await client.query("UPDATE pools SET state=$1, participants=array_append(participants,$2), updated=now() WHERE code=$3", [st, userId, code]);
      await client.query("DELETE FROM pool_invites WHERE pool_code=$1 AND to_user=$2", [code, userId]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  res.json(poolSafeState(st, userId));
}));

// host closes (deletes) a pool — any status, any time. Unlike drafts there's no
// turn-order fairness concern to protect; this is squarely for "nobody joined" or
// "made this by accident" cleanup.
app.post("/api/pool/:code/close", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { hostId } = req.body;
  const r = await pool.query("SELECT state FROM pools WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Pool not found" });
  if (st.hostId !== hostId) return res.status(403).json({ error: "Only the host can close this pool" });
  await pool.query("DELETE FROM pools WHERE code=$1", [code]);
  res.json({ ok: true });
}));

// leave a pool before it locks — after the first week locks, entries (and exits) are
// frozen for the rest of the pool, same as entries closing to new joiners
app.post("/api/pool/:code/leave", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId } = req.body;
  const r = await pool.query("SELECT state FROM pools WHERE code=$1", [code]);
  const st = r.rows[0]?.state;
  if (!st) return res.status(404).json({ error: "Pool not found" });
  if (st.status !== "open") return res.status(400).json({ error: "This pool has already started — picks are locked in for the rest of it" });
  st.entries = st.entries.filter((e) => e.userId !== userId);
  if (st.hostId === userId) {
    if (!st.entries.length) {
      await pool.query("DELETE FROM pools WHERE code=$1", [code]);
      return res.json({ ok: true });
    }
    st.hostId = st.entries[0].userId; // hand host to the next entrant so the pool isn't orphaned
  }
  await pool.query("UPDATE pools SET state=$1, participants=array_remove(participants,$2), updated=now() WHERE code=$3", [st, userId, code]);
  res.json({ ok: true });
}));

app.post("/api/pool/:code/pick", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId, team } = req.body;
  const client = await pool.connect();
  let st;
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT state FROM pools WHERE code=$1 FOR UPDATE", [code]);
    st = r.rows[0]?.state;
    if (!st) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Pool not found" }); }
    const entry = st.entries.find((e) => e.userId === userId);
    if (!entry) { await client.query("ROLLBACK"); return res.status(403).json({ error: "Not in this pool" }); }
    if (!entry.alive) { await client.query("ROLLBACK"); return res.status(400).json({ error: "You've been eliminated" }); }
    if (Date.now() >= st.week.deadline) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Picks are locked for this week" }); }
    const teamAbbr = String(team || "").toUpperCase();
    const validTeam = st.week.games.some((g) => g.away === teamAbbr || g.home === teamAbbr);
    if (!validTeam) { await client.query("ROLLBACK"); return res.status(400).json({ error: "That team isn't playing this week" }); }
    if (entry.usedTeams.includes(teamAbbr)) { await client.query("ROLLBACK"); return res.status(400).json({ error: `You've already used ${teamAbbr} — pick a different team` }); }
    entry.picks = entry.picks.filter((p) => p.weekKey !== st.week.key)
      .concat([{ weekKey: st.week.key, team: teamAbbr, locked: false, result: "pending", pickedAt: Date.now() }]);
    await client.query("UPDATE pools SET state=$1, updated=now() WHERE code=$2", [st, code]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  res.json(poolSafeState(st, userId));
}));

app.post("/api/pool/:code/handshake", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { userId } = req.body;
  const result = await agreeHandshake("pools", code, userId);
  if (result.error) return res.status(result.error).json({ error: result.msg });
  res.json({ ok: true });
}));

app.post("/api/pool/:code/invite", ah(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { fromId, toUserId } = req.body;
  const from = (await pool.query("SELECT name FROM users WHERE id=$1", [fromId])).rows[0];
  await pool.query("INSERT INTO pool_invites (pool_code, to_user, from_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [code, toUserId, from?.name || "A friend"]);
  res.json({ ok: true });
}));

app.delete("/api/admin/pool/:code", ah(async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const code = req.params.code.toUpperCase();
  await pool.query("DELETE FROM pools WHERE code=$1", [code]);
  res.json({ ok: true, deleted: code });
}));

// testing only — runs the weekly tick against a real *completed* historical week so
// lock/reveal/eliminate can be exercised without waiting on a live week to finish.
// `override` never reaches survivorWeek() from any public route — only from here.
app.post("/api/admin/pool/:code/simulate-week", ah(async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  const code = req.params.code.toUpperCase();
  const { season, week, seasonType } = req.body;
  if (!season || !week || !seasonType) return res.status(400).json({ error: "season, week, seasonType required" });
  const live = await scoring.survivorWeek("NFL", { season, week, seasonType });
  if (!live) return res.status(502).json({ error: "Couldn't fetch that week from ESPN" });
  await tickPool(code, live);
  const r = await pool.query("SELECT state FROM pools WHERE code=$1", [code]);
  res.json(r.rows[0]?.state || null);
}));

// spa fallback for invite links
app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
const SCORE_POLL_MIN = +(process.env.SCORE_POLL_MIN || 5);
// Auto-close lobby rooms that never start (public 1h, private 12h) and stuck active drafts.
// Uses createdAt from state when present, falls back to DB updated column.
async function cleanupStaleLobbies() {
  try {
    // Public lobbies: close after 1 hour with no start
    const r = await pool.query(
      `SELECT code FROM drafts
       WHERE (state->>'status') = 'lobby'
       AND (state->>'public') = 'true'
       AND (state->>'startingAt') IS NULL
       AND (
         ((state->>'createdAt') IS NOT NULL AND (state->>'createdAt')::bigint < $1)
         OR ((state->>'createdAt') IS NULL AND updated < now() - interval '1 hour')
       )`,
      [Date.now() - 60 * 60 * 1000]
    );
    for (const row of r.rows) {
      await pool.query("DELETE FROM drafts WHERE code=$1", [row.code]);
      broadcastDeleted(row.code);
      console.log("Auto-closed expired public lobby:", row.code);
    }
    // Private (friends-only) lobbies: close after 12 hours with no start
    const stalePrivate = await pool.query(
      `SELECT code FROM drafts
       WHERE (state->>'status') = 'lobby'
       AND (state->>'public') != 'true'
       AND (state->>'startingAt') IS NULL
       AND updated < now() - interval '12 hours'`
    );
    for (const row of stalePrivate.rows) {
      await pool.query("DELETE FROM drafts WHERE code=$1", [row.code]);
      broadcastDeleted(row.code);
      console.log("Auto-removed stale private lobby:", row.code);
    }
    // Nuke timed active drafts idle for 4+ hours (timer expired, nobody picking)
    const staleActive = await pool.query(
      `SELECT code FROM drafts
       WHERE (state->>'status') = 'active'
       AND (state->>'pickTimer') IS NOT NULL
       AND updated < now() - interval '4 hours'`
    );
    for (const row of staleActive.rows) {
      await pool.query("DELETE FROM drafts WHERE code=$1", [row.code]);
      broadcastDeleted(row.code);
      console.log("Auto-removed stale timed active draft:", row.code);
    }
    // Nuke active drafts where nobody ever made a single pick — stuck at the gate
    const noPicks = await pool.query(
      `SELECT code FROM drafts
       WHERE (state->>'status') = 'active'
       AND jsonb_array_length(state->'picks') = 0
       AND updated < now() - interval '2 hours'`
    );
    for (const row of noPicks.rows) {
      await pool.query("DELETE FROM drafts WHERE code=$1", [row.code]);
      broadcastDeleted(row.code);
      console.log("Auto-removed stuck active draft (0 picks, 2h idle):", row.code);
    }
    // Also nuke ALL active drafts idle for 24+ hours (covers no-timer stuck drafts)
    const allStaleActive = await pool.query(
      `SELECT code FROM drafts
       WHERE (state->>'status') = 'active'
       AND updated < now() - interval '24 hours'`
    );
    for (const row of allStaleActive.rows) {
      await pool.query("DELETE FROM drafts WHERE code=$1", [row.code]);
      broadcastDeleted(row.code);
      console.log("Auto-removed stale active draft (24h idle):", row.code);
    }
  } catch (e) { console.error("lobby cleanup", e.message); }
}

// ---------------- survivor pool weekly tick ----------------
const SURVIVOR_POLL_MIN = +(process.env.SURVIVOR_POLL_MIN || 3);

async function processSurvivorPools() {
  try {
    const live = await scoring.survivorWeek("NFL").catch((e) => { console.error("survivorWeek", e.message); return null; });
    const rows = (await pool.query(`SELECT code FROM pools WHERE (state->>'status') != 'complete'`)).rows;
    for (const { code } of rows) await tickPool(code, live);
  } catch (e) { console.error("processSurvivorPools", e.message); }
}

async function tickPool(code, live) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT state FROM pools WHERE code=$1 FOR UPDATE", [code]);
    const st = r.rows[0]?.state;
    if (!st) { await client.query("ROLLBACK"); return; }
    const now = Date.now();
    let changed = false;

    // (a) deadline lock: auto-eliminate anyone alive who never picked
    if (!st.week.locked && now >= st.week.deadline) {
      for (const e of st.entries) {
        if (!e.alive) continue;
        const p = e.picks.find((p) => p.weekKey === st.week.key);
        if (!p) { e.picks.push({ weekKey: st.week.key, team: null, locked: true, result: "missed" }); e.alive = false; e.eliminatedWeek = st.week.key; }
        else p.locked = true;
      }
      st.week.locked = true;
      if (st.status === "open") st.status = "active"; // entries close for good once the first week locks
      changed = true;
    }

    // (b) reminders — 24h and 3h before deadline, only to alive entrants who haven't picked yet
    for (const [win, hrs] of [["24h", 24], ["3h", 3]]) {
      if (!st.week.remindersSent[win] && now >= st.week.deadline - hrs * 3600e3 && now < st.week.deadline) {
        const targets = st.entries.filter((e) => e.alive && !e.picks.find((p) => p.weekKey === st.week.key));
        await Promise.all(targets.map((e) => sendPush(e.userId, {
          title: hrs === 3 ? "⏰ Last call to pick!" : "Pick reminder",
          body: `${hrs} hours left to make your pick in "${st.name}"`,
          data: { poolCode: code, kind: "survivor-reminder" },
        }).catch(() => {})));
        st.week.remindersSent[win] = true; changed = true;
      }
    }

    // (c) results + eliminations, once this week's games are all final
    if (st.week.locked && !st.week.eliminationsProcessed && live?.weekKey === st.week.key && live.allFinal) {
      for (const e of st.entries) {
        const p = e.picks.find((p) => p.weekKey === st.week.key);
        if (!p || p.team == null) continue; // already "missed"
        const g = live.games.find((g) => g.away === p.team || g.home === p.team);
        const result = !g || g.winner == null ? "push" : g.winner === p.team ? "win" : "loss";
        p.result = result;
        e.usedTeams.push(p.team); // finalize the used-team lock only now
        if (result === "loss") { e.alive = false; e.eliminatedWeek = st.week.key; }
      }
      st.week.eliminationsProcessed = true;
      const stillAlive = st.entries.filter((e) => e.alive);
      if (stillAlive.length === 0) { st.status = "complete"; st.winners = st.entries.filter((e) => e.eliminatedWeek === st.week.key).map((e) => e.userId); }
      else if (stillAlive.length === 1 && st.entries.length > 1) { st.status = "complete"; st.winners = [stillAlive[0].userId]; }
      changed = true;
    }

    // (d) advance to next week once this week is fully processed and ESPN has moved on
    if (st.status === "active" && st.week.eliminationsProcessed && live && live.weekKey !== st.week.key) {
      const pre = live.games.filter((g) => g.state === "pre");
      if (pre.length) {
        st.week = {
          key: live.weekKey, deadline: Math.min(...pre.map((g) => g.kickoff)),
          games: pre, remindersSent: { "24h": false, "3h": false }, locked: false, eliminationsProcessed: false,
        };
        changed = true;
      }
    }

    if (changed) await client.query("UPDATE pools SET state=$1, updated=now() WHERE code=$2", [st, code]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); console.error("tickPool", code, e.message); }
  finally { client.release(); }
}

// Graceful shutdown: Render sends SIGTERM on every deploy — finish in-flight
// requests and release DB connections instead of dropping them mid-pick.
process.on("SIGTERM", () => {
  console.log("SIGTERM — draining connections");
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref(); // hard stop if something hangs
});

initDb().then(() => {
  server.listen(PORT, () => console.log("SquabbleUP live on :" + PORT));
  if (process.env.DEMO_STATS === "on") scoring.seedDemo(pool).catch((e) => console.error("demo seed", e.message));
  if (process.env.SCORING !== "off") {
    scoring.pollAll(pool).catch((e) => console.error("score poll", e.message));
    setInterval(() => scoring.pollAll(pool).catch((e) => console.error("score poll", e.message)), SCORE_POLL_MIN * 60 * 1000);
  }
  cleanupStaleLobbies();
  setInterval(cleanupStaleLobbies, 60 * 1000);

  processSurvivorPools();
  setInterval(processSurvivorPools, SURVIVOR_POLL_MIN * 60 * 1000);

  // Shared "best available player" pick, used by both trigger paths below.
  async function pickBestAvailable(st) {
    const taken = new Set(st.picks.map((p) => p.player));
    const { players: todayNames, roster: todayRoster } = await resolveDraftPool(st.sport, st.gameFilter);
    const playerPool = todayRoster.length > 0 ? todayRoster : PLAYERS.filter((p) => st.sport === "ALL" || p.sp === st.sport);
    const rankMap = new Map(PLAYERS.map((p) => [p.n, p.r]));
    return playerPool
      .filter((p) => !taken.has(p.n))
      .filter((p) => st.sport === "ALL" || p.sp === st.sport)
      .filter((p) => !todayNames || todayNames.has(p.n))
      .filter((p) => !p.livelock)
      .sort((a, b) => (rankMap.get(a.n) || 999) - (rankMap.get(b.n) || 999))[0];
  }

  // Server-side auto-draft, two independent triggers:
  //  1. the draft's pick timer expired (host-configured anti-stall setting), or
  //  2. the current picker has "Auto Draft" turned on AND at least AUTO_GRACE_MS has passed
  //     since their turn began — auto-draft normally fires client-side (fireAutoDraft, ~1.2s),
  //     so this is the fallback that keeps a seat drafting once the app is closed or
  //     backgrounded. The grace period matters: without it, an actively-present player whose
  //     seat has autoDraft on (e.g. from a past timeout) would have their own manual clicks
  //     raced and sometimes beaten by this poller, which looks exactly like "the draft button
  //     doesn't work" — 8s is far more than a connected client needs, but still short enough
  //     not to hold up anyone who's actually gone.
  // A live, connected client almost always wins the race regardless — the picks-length-guarded
  // UPDATE below just no-ops if it already did.
  //
  // The first time someone times out, their seat flips to Auto Draft for the rest of the
  // draft — otherwise every future round would make everyone else wait out their timer
  // again before the same fallback kicks in. They're notified and can turn it back off
  // themselves (the toggle) at any time if they come back.
  const AUTO_GRACE_MS = 8000;
  async function serverAutoDraft(code, st) {
    try {
      if (st.status !== "active" || isDone(st)) return;
      const seat = st.seats[pickerIndex(st)];
      if (!seat || seat.bot) return; // bots have their own scheduler
      const timerExpired = st.pickTimer && st.pickStartedAt && st.pickStartedAt + st.pickTimer * 1000 <= Date.now();
      const autoGraceElapsed = seat.autoDraft && st.pickStartedAt && Date.now() - st.pickStartedAt >= AUTO_GRACE_MS;
      if (!timerExpired && !autoGraceElapsed) return;
      const pick = await pickBestAvailable(st);
      if (!pick) return;
      const prevLen = st.picks.length;
      const turningOnAuto = timerExpired && !seat.autoDraft;
      applyPick(st, pick);
      if (turningOnAuto) seat.autoDraft = true;
      if (isDone(st)) {
        finishDraft(st);
        lastNotifiedPick.delete(code);
        if (pendingPickNotify.has(code)) { clearTimeout(pendingPickNotify.get(code)); pendingPickNotify.delete(code); }
      }
      const upd = await pool.query(
        "UPDATE drafts SET state=$1, updated=now() WHERE code=$2 AND jsonb_array_length(state->'picks')=$3",
        [st, code, prevLen]
      );
      if (upd.rowCount === 0) return; // another process (or the live client) beat us to it
      broadcast(code).catch(console.error);
      console.log(`Server auto-drafted ${pick.n} for ${seat.name} in ${code}`);
      if (turningOnAuto && seat.userId) {
        sendPush(seat.userId, {
          title: "⚡ Auto Draft turned on",
          body: `You missed a pick deadline in ${st.name} — we'll auto-draft the rest of your picks so nobody's held up. Tap to turn it off.`,
          data: { draftCode: code },
        }).catch(() => {});
      }
    } catch (e) { console.error("serverAutoDraft", e.message); }
  }

  // Countdown safety net + server-side auto-draft poller (runs every 5s)
  setInterval(async () => {
    try {
      // 1. Activate any countdown lobbies whose timer has elapsed
      const cd = await pool.query(
        `SELECT code FROM drafts
         WHERE (state->>'status') = 'lobby'
         AND (state->>'startingAt') IS NOT NULL
         AND (state->>'startingAt')::bigint < $1`,
        [Date.now()]
      );
      await Promise.all(cd.rows.map((row) => activateCountdown(row.code)));

      // 2. Auto-draft every active draft — serverAutoDraft() itself no-ops unless the
      // pick timer expired or the current seat has Auto Draft on, so this only ever
      // does real work for the (small) subset of drafts that actually need it.
      const active = await pool.query(`SELECT code, state FROM drafts WHERE (state->>'status') = 'active'`);
      await Promise.all(active.rows.map((row) => serverAutoDraft(row.code, row.state)));
    } catch (e) { console.error("poller", e.message); }
  }, 5000);
});
