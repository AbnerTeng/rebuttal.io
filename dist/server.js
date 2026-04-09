"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const socket_io_1 = require("socket.io");
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
// ── Config ───────────────────────────────────────────────────────────────────
const SKIP_AUTH = process.env.SKIP_AUTH === 'true';
const MOCK_USER_ID = 'user_mock_dev';
const MOCK_USERNAME = 'dev';
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const DB_PATH = process.env.DB_PATH || path_1.default.join(__dirname, '..', 'rebuttals.db');
const INVITE_TTL_DAYS = 7;
const BCRYPT_ROUNDS = 12;
const SESSION_TTL_DAYS = 7;
const COOKIE_NAME = 'session';
// If JWT_SECRET is not set, generate a random one (sessions won't survive restarts).
const JWT_SECRET = process.env.JWT_SECRET ?? (() => {
    console.warn('⚠️  JWT_SECRET not set — sessions will reset on restart. Add JWT_SECRET to .env');
    return crypto_1.default.randomBytes(32).toString('hex');
})();
// ── Express + HTTP server ────────────────────────────────────────────────────
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
function signSession(userId, username) {
    return jsonwebtoken_1.default.sign({ sub: userId, username }, JWT_SECRET, {
        expiresIn: `${SESSION_TTL_DAYS}d`,
    });
}
function verifySession(token) {
    try {
        return jsonwebtoken_1.default.verify(token, JWT_SECRET);
    }
    catch {
        return null;
    }
}
function getTokenFromCookie(cookieHeader) {
    if (!cookieHeader)
        return null;
    const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}
function setSessionCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'strict',
        maxAge: SESSION_TTL_DAYS * 86400 * 1000,
        path: '/',
    });
}
function requireUser(req, res, next) {
    if (SKIP_AUTH) {
        req.userId = MOCK_USER_ID;
        req.username = MOCK_USERNAME;
        return next();
    }
    const token = req.cookies?.[COOKIE_NAME];
    const payload = token ? verifySession(token) : null;
    if (!payload) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    req.userId = payload.sub;
    req.username = payload.username;
    next();
}
function getUserId(req) {
    return SKIP_AUTH ? MOCK_USER_ID : req.userId;
}
// ── Database ─────────────────────────────────────────────────────────────────
const db = new better_sqlite3_1.default(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rebuttals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL DEFAULT 'Untitled',
    venue      TEXT    NOT NULL DEFAULT '',
    owner_id   TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    data       TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rebuttal_id INTEGER NOT NULL REFERENCES rebuttals(id) ON DELETE CASCADE,
    snapshot_at TEXT    NOT NULL DEFAULT (datetime('now')),
    note        TEXT    NOT NULL DEFAULT '',
    data        TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS rebuttal_members (
    rebuttal_id INTEGER NOT NULL REFERENCES rebuttals(id) ON DELETE CASCADE,
    user_id     TEXT    NOT NULL,
    role        TEXT    NOT NULL CHECK(role IN ('owner','editor')) DEFAULT 'editor',
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (rebuttal_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS invites (
    token       TEXT    PRIMARY KEY,
    rebuttal_id INTEGER NOT NULL REFERENCES rebuttals(id) ON DELETE CASCADE,
    created_by  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_history_rebuttal   ON history(rebuttal_id, snapshot_at DESC);
  CREATE INDEX IF NOT EXISTS idx_members_user        ON rebuttal_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_members_rebuttal    ON rebuttal_members(rebuttal_id);
`);
// Migrate: add owner_id column to existing tables if missing
try {
    db.exec(`ALTER TABLE rebuttals ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`);
}
catch { }
// ── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
    // All authenticated users see all projects — ownership only gates deletion
    listRebuttals: db.prepare(`
    SELECT id, title, venue, owner_id, created_at, updated_at
    FROM rebuttals
    ORDER BY updated_at DESC
  `),
    getRebuttal: db.prepare(`SELECT * FROM rebuttals WHERE id = ?`),
    // Any authenticated user can access any rebuttal
    canAccess: db.prepare(`SELECT 1 FROM rebuttals WHERE id = @rid`),
    isOwner: db.prepare(`
    SELECT 1 FROM rebuttal_members
    WHERE rebuttal_id = @rid AND user_id = @uid AND role = 'owner'
  `),
    insertRebuttal: db.prepare(`INSERT INTO rebuttals (title, venue, owner_id, data) VALUES (@title, @venue, @owner_id, @data)`),
    updateRebuttal: db.prepare(`UPDATE rebuttals SET title=@title, venue=@venue, data=@data, updated_at=datetime('now') WHERE id=@id`),
    deleteRebuttal: db.prepare(`DELETE FROM rebuttals WHERE id = ?`),
    insertMember: db.prepare(`INSERT OR IGNORE INTO rebuttal_members (rebuttal_id, user_id, role) VALUES (@rebuttal_id, @user_id, @role)`),
    getMembers: db.prepare(`SELECT user_id, role FROM rebuttal_members WHERE rebuttal_id = ?`),
    removeMember: db.prepare(`DELETE FROM rebuttal_members WHERE rebuttal_id = @rid AND user_id = @uid`),
    insertHistory: db.prepare(`INSERT INTO history (rebuttal_id, note, data) VALUES (@rebuttal_id, @note, @data)`),
    listHistory: db.prepare(`SELECT id, rebuttal_id, snapshot_at, note FROM history WHERE rebuttal_id=? ORDER BY snapshot_at DESC`),
    getSnapshot: db.prepare(`SELECT * FROM history WHERE id=?`),
    deleteSnapshot: db.prepare(`DELETE FROM history WHERE id=?`),
    pruneHistory: db.prepare(`
    DELETE FROM history WHERE rebuttal_id=@rid AND id NOT IN (
      SELECT id FROM history WHERE rebuttal_id=@rid ORDER BY snapshot_at DESC LIMIT @keep
    )
  `),
    insertInvite: db.prepare(`INSERT INTO invites (token, rebuttal_id, created_by, expires_at) VALUES (@token, @rebuttal_id, @created_by, @expires_at)`),
    getInvite: db.prepare(`SELECT * FROM invites WHERE token = ?`),
    markInviteUsed: db.prepare(`UPDATE invites SET used = 1 WHERE token = ?`),
    deleteExpired: db.prepare(`DELETE FROM invites WHERE expires_at < datetime('now')`),
};
const HISTORY_KEEP = 50;
// ── Live state (in-memory per open rebuttal) ─────────────────────────────────
const liveState = new Map();
const flushTimers = new Map();
function getLiveState(rebId) {
    if (liveState.has(rebId))
        return liveState.get(rebId);
    const row = stmts.getRebuttal.get(rebId);
    if (!row)
        return null;
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    liveState.set(rebId, data);
    return data;
}
function schedulePersist(rebId) {
    if (flushTimers.has(rebId))
        clearTimeout(flushTimers.get(rebId));
    flushTimers.set(rebId, setTimeout(() => {
        const state = liveState.get(rebId);
        if (!state)
            return;
        const row = stmts.getRebuttal.get(rebId);
        if (!row)
            return;
        stmts.updateRebuttal.run({
            id: rebId,
            title: state.paperTitle || row.title,
            venue: state.venue || row.venue,
            data: JSON.stringify(state),
        });
    }, 1500));
}
function applyPatch(obj, dotPath, value) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object')
            return false;
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return true;
}
// ── Peer colours ─────────────────────────────────────────────────────────────
const PEER_COLORS = ['#6c7ef8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#38bdf8', '#fb7185', '#4ade80'];
let colorIdx = 0;
function nextColor() { return PEER_COLORS[colorIdx++ % PEER_COLORS.length]; }
// ── Socket.io ────────────────────────────────────────────────────────────────
const io = new socket_io_1.Server(server, {
    cors: { origin: '*' },
});
// Auth middleware for Socket.io — uses a short-lived token fetched from /api/auth/socket-token
io.use((socket, next) => {
    if (SKIP_AUTH) {
        socket.data.userId = MOCK_USER_ID;
        socket.data.name = MOCK_USERNAME;
        return next();
    }
    const token = socket.handshake.auth?.token;
    const payload = token ? verifySession(token) : null;
    if (!payload)
        return next(new Error('Unauthorized'));
    socket.data.userId = payload.sub;
    socket.data.name = payload.username;
    next();
});
io.on('connection', (socket) => {
    socket.data.rebId = null;
    socket.data.color = nextColor();
    socket.on('join', (rebId) => {
        if (socket.data.rebId !== null) {
            socket.leave(`reb:${socket.data.rebId}`);
            broadcastPresence(socket.data.rebId);
        }
        socket.data.rebId = rebId;
        socket.join(`reb:${rebId}`);
        const state = getLiveState(rebId);
        if (state)
            socket.emit('sync', { state });
        broadcastPresence(rebId);
    });
    socket.on('patch', (payload) => {
        const rebId = socket.data.rebId;
        if (rebId === null)
            return;
        const state = getLiveState(rebId);
        if (!state)
            return;
        applyPatch(state, payload.path, payload.value);
        schedulePersist(rebId);
        socket.to(`reb:${rebId}`).emit('patch', payload);
    });
    socket.on('disconnect', () => {
        if (socket.data.rebId !== null)
            broadcastPresence(socket.data.rebId);
    });
});
function broadcastPresence(rebId) {
    const room = io.sockets.adapter.rooms.get(`reb:${rebId}`);
    if (!room)
        return;
    const peers = [...room].map((sid) => {
        const s = io.sockets.sockets.get(sid);
        return { socketId: sid, color: s?.data.color ?? '#fff', name: s?.data.name ?? 'Anonymous' };
    });
    io.to(`reb:${rebId}`).emit('presence', { peers });
}
// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express_1.default.json({ limit: '2mb' }));
app.use((0, cookie_parser_1.default)());
app.use(express_1.default.static(path_1.default.join(__dirname, '..', 'public')));
// ── Config endpoint ───────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
    res.json({ skipAuth: SKIP_AUTH });
});
// ── Auth routes ───────────────────────────────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
app.post('/api/auth/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        res.status(400).json({ error: 'Username and password required' });
        return;
    }
    if (!USERNAME_RE.test(username)) {
        res.status(400).json({ error: 'Username must be 3–30 characters: letters, numbers, underscores only' });
        return;
    }
    if (password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters' });
        return;
    }
    if (password.length > 72) {
        res.status(400).json({ error: 'Password too long' });
        return;
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
        res.status(409).json({ error: 'Username already taken' });
        return;
    }
    const hash = await bcrypt_1.default.hash(password, BCRYPT_ROUNDS);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    const userId = String(result.lastInsertRowid);
    const token = signSession(userId, username);
    setSessionCookie(res, token);
    res.status(201).json({ username });
});
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        res.status(400).json({ error: 'Username and password required' });
        return;
    }
    const row = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username);
    // Always run bcrypt compare to prevent timing attacks
    const hash = row?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000000';
    const match = await bcrypt_1.default.compare(password, hash);
    if (!row || !match) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
    }
    const token = signSession(String(row.id), username);
    setSessionCookie(res, token);
    res.json({ username });
});
app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
});
// Short-lived token for socket.io auth (HttpOnly cookies can't be read by JS)
app.get('/api/auth/socket-token', requireUser, (req, res) => {
    const token = jsonwebtoken_1.default.sign({ sub: req.userId, username: req.username }, JWT_SECRET, { expiresIn: '5m' });
    res.json({ token });
});
app.get('/api/auth/me', (req, res) => {
    if (SKIP_AUTH) {
        res.json({ username: MOCK_USERNAME });
        return;
    }
    const token = req.cookies?.[COOKIE_NAME];
    const payload = token ? verifySession(token) : null;
    if (!payload) {
        res.status(401).json({ error: 'Not logged in' });
        return;
    }
    res.json({ username: payload.username });
});
// ── API: Rebuttals ────────────────────────────────────────────────────────────
app.get('/api/rebuttals', requireUser, (_req, res) => {
    res.json(stmts.listRebuttals.all());
});
app.get('/api/rebuttals/:id', requireUser, (req, res) => {
    const rebId = parseInt(req.params.id);
    const uid = getUserId(req);
    if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId })) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    const row = stmts.getRebuttal.get(rebId);
    if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const live = liveState.get(rebId);
    const data = live ?? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
    res.json({ ...row, data });
});
app.post('/api/rebuttals', requireUser, (req, res) => {
    const uid = getUserId(req);
    const { title = 'Untitled', venue = '', data = {} } = req.body;
    const result = stmts.insertRebuttal.run({ title, venue, owner_id: uid, data: JSON.stringify(data) });
    const rebId = result.lastInsertRowid;
    stmts.insertMember.run({ rebuttal_id: rebId, user_id: uid, role: 'owner' });
    const row = stmts.getRebuttal.get(rebId);
    res.status(201).json({ ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data });
});
app.put('/api/rebuttals/:id', requireUser, (req, res) => {
    const rebId = parseInt(req.params.id);
    const uid = getUserId(req);
    if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId })) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    const existing = stmts.getRebuttal.get(rebId);
    if (!existing) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const { title, venue, data, snapshot, snapshotNote = '' } = req.body;
    const existingData = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
    db.transaction(() => {
        if (snapshot) {
            stmts.insertHistory.run({ rebuttal_id: rebId, note: snapshotNote, data: JSON.stringify(existingData) });
            stmts.pruneHistory.run({ rid: rebId, keep: HISTORY_KEEP });
        }
        const resolved = data ?? existingData;
        stmts.updateRebuttal.run({
            id: rebId,
            title: title ?? resolved?.paperTitle ?? existing.title,
            venue: venue ?? existing.venue,
            data: JSON.stringify(resolved),
        });
        if (data)
            liveState.set(rebId, data);
    })();
    const row = stmts.getRebuttal.get(rebId);
    const live = liveState.get(rebId);
    res.json({ ...row, data: live ?? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) });
});
app.delete('/api/rebuttals/:id', requireUser, (req, res) => {
    const rebId = parseInt(req.params.id);
    const uid = getUserId(req);
    if (!SKIP_AUTH && !stmts.isOwner.get({ rid: rebId, uid })) {
        res.status(403).json({ error: 'Only the owner can delete' });
        return;
    }
    liveState.delete(rebId);
    flushTimers.delete(rebId);
    stmts.deleteRebuttal.run(rebId);
    res.json({ ok: true });
});
// ── API: History ──────────────────────────────────────────────────────────────
app.get('/api/rebuttals/:id/history', requireUser, (req, res) => {
    const rebId = parseInt(req.params.id);
    const uid = getUserId(req);
    if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId })) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    res.json(stmts.listHistory.all(rebId));
});
app.get('/api/history/:snapshotId', requireUser, (req, res) => {
    const row = stmts.getSnapshot.get(req.params.snapshotId);
    if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    res.json({ ...row, data: JSON.parse(row.data) });
});
app.post('/api/rebuttals/:id/history', requireUser, (req, res) => {
    const rebId = parseInt(req.params.id);
    const uid = getUserId(req);
    if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId })) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    const existing = stmts.getRebuttal.get(rebId);
    if (!existing) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const { note = '' } = req.body;
    const live = liveState.get(rebId);
    const dataToSnap = live ? JSON.stringify(live) : (typeof existing.data === 'string' ? existing.data : JSON.stringify(existing.data));
    const result = stmts.insertHistory.run({ rebuttal_id: rebId, note, data: dataToSnap });
    stmts.pruneHistory.run({ rid: rebId, keep: HISTORY_KEEP });
    res.status(201).json({ id: result.lastInsertRowid, note });
});
app.delete('/api/history/:snapshotId', requireUser, (req, res) => {
    if (!stmts.getSnapshot.get(req.params.snapshotId)) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    stmts.deleteSnapshot.run(req.params.snapshotId);
    res.json({ ok: true });
});
// ── API: Invites ──────────────────────────────────────────────────────────────
// Create an invite link for a rebuttal
app.post('/api/rebuttals/:id/invite', requireUser, (req, res) => {
    const rebId = parseInt(req.params.id);
    const uid = getUserId(req);
    if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId })) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    stmts.deleteExpired.run(); // housekeeping
    const token = crypto_1.default.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();
    stmts.insertInvite.run({ token, rebuttal_id: rebId, created_by: uid, expires_at: expiresAt });
    const protocol = (Array.isArray(req.headers['x-forwarded-proto']) ? req.headers['x-forwarded-proto'][0] : req.headers['x-forwarded-proto']) ?? req.protocol;
    const host = (Array.isArray(req.headers['x-forwarded-host']) ? req.headers['x-forwarded-host'][0] : req.headers['x-forwarded-host']) ?? req.get('host');
    res.json({ token, url: `${protocol}://${host}/invite/${token}` });
});
// Accept an invite (called from the invite page after sign-in)
app.post('/api/invite/:token/accept', requireUser, (req, res) => {
    const uid = getUserId(req);
    const invite = stmts.getInvite.get(req.params.token);
    if (!invite) {
        res.status(404).json({ error: 'Invalid or expired invite' });
        return;
    }
    if (invite.used) {
        res.status(410).json({ error: 'Invite already used' });
        return;
    }
    if (new Date(invite.expires_at) < new Date()) {
        res.status(410).json({ error: 'Invite expired' });
        return;
    }
    stmts.insertMember.run({ rebuttal_id: invite.rebuttal_id, user_id: uid, role: 'editor' });
    stmts.markInviteUsed.run(invite.token);
    res.json({ rebuttal_id: invite.rebuttal_id });
});
// ── Invite landing page ───────────────────────────────────────────────────────
app.get('/invite/:token', (req, res) => {
    const inviteToken = req.params.token;
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Join Rebuttal</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0f1117; color:#e2e8f0;
    display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .card { background:#1a1d27; border:1px solid #2e3250; border-radius:12px; padding:32px;
    max-width:400px; width:90%; text-align:center; }
  h2 { margin:0 0 8px; font-size:1.2rem; }
  p  { color:#7c84a3; font-size:0.88rem; margin:0 0 16px; }
  input { width:100%; padding:8px 12px; border-radius:6px; border:1px solid #2e3250;
    background:#22263a; color:#e2e8f0; font-size:0.9rem; margin-bottom:8px; box-sizing:border-box; }
  button { width:100%; padding:9px; border-radius:6px; border:none; background:#6c7ef8;
    color:#fff; font-weight:600; cursor:pointer; font-size:0.9rem; }
  .msg { font-size:0.82rem; color:#7c84a3; margin-top:12px; }
  .err { color:#f87171; }
</style>
</head>
<body>
<div class="card">
  <h2>You've been invited to collaborate</h2>
  <div id="loginForm">
    <p>Sign in to join this rebuttal.</p>
    <input id="username" type="text" placeholder="Username" autocomplete="username">
    <input id="password" type="password" placeholder="Password" autocomplete="current-password">
    <p id="err" class="msg err" style="display:none"></p>
    <button onclick="doAccept()">Join</button>
    <p class="msg">No account? <a href="/" style="color:#6c7ef8">Sign up first</a>, then use the invite link again.</p>
  </div>
  <div id="msg" class="msg" style="display:none"></div>
</div>
<script>
const INVITE_TOKEN = ${JSON.stringify(inviteToken)};

async function doAccept() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('err');
  errEl.style.display = 'none';

  // Login first
  const loginRes = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!loginRes.ok) {
    const d = await loginRes.json();
    errEl.textContent = d.error ?? 'Login failed';
    errEl.style.display = 'block';
    return;
  }

  // Accept invite (cookie is now set)
  const r = await fetch('/api/invite/' + INVITE_TOKEN + '/accept', {
    method: 'POST', credentials: 'same-origin',
  });
  const data = await r.json();
  if (r.ok) {
    window.location.href = '/?r=' + data.rebuttal_id;
  } else {
    document.getElementById('loginForm').style.display = 'none';
    const msg = document.getElementById('msg');
    msg.style.display = 'block';
    msg.textContent = 'Error: ' + data.error;
  }
}

// Check if already logged in
fetch('/api/auth/me').then(async r => {
  if (r.ok) {
    // Already logged in — accept directly
    document.getElementById('loginForm').style.display = 'none';
    const msg = document.getElementById('msg');
    msg.style.display = 'block';
    msg.textContent = 'Accepting invite…';
    const res = await fetch('/api/invite/' + INVITE_TOKEN + '/accept', {
      method: 'POST', credentials: 'same-origin',
    });
    const data = await res.json();
    if (res.ok) window.location.href = '/?r=' + data.rebuttal_id;
    else msg.textContent = 'Error: ' + data.error;
  }
});

document.getElementById('password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doAccept();
});
</script>
</body>
</html>`);
});
// ── Serve frontend ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path_1.default.join(__dirname, '..', 'public', 'index.html')));
server.listen(PORT, () => {
    const mode = SKIP_AUTH ? 'no-auth (SKIP_AUTH=true)' : 'custom auth';
    console.log(`Rebuttal UI → http://localhost:${PORT}  [${mode}]`);
});
