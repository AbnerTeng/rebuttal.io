import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Server } from 'socket.io';
import { clerkMiddleware, requireAuth, getAuth } from '@clerk/express';
import { createClerkClient, verifyToken } from '@clerk/backend';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  FieldPatch,
  RebuttalData,
  RebuttalRow,
  InviteRow,
  ClientConfig,
} from './types.js';

// ── Config ───────────────────────────────────────────────────────────────────
const SKIP_AUTH = process.env.SKIP_AUTH === 'true';
const MOCK_USER_ID = 'user_mock_dev';
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'rebuttals.db');
const INVITE_TTL_DAYS = 7;

// clerkClient used only for future admin operations; token verification uses verifyToken()
createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY ?? '' });

// ── Express + HTTP server ────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

if (!SKIP_AUTH) app.use(clerkMiddleware());

function getUserId(req: Request): string {
  if (SKIP_AUTH) return MOCK_USER_ID;
  const { userId } = getAuth(req);
  return userId!;
}

function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_AUTH) return next();
  requireAuth()(req, res, next);
}

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
try { db.exec(`ALTER TABLE rebuttals ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`); } catch {}

// ── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  // Rebuttals – only return rows the user owns or is a member of
  // Rows with owner_id='' are "legacy open" (accessible to all authed users)
  listRebuttals: db.prepare(`
    SELECT r.id, r.title, r.venue, r.owner_id, r.created_at, r.updated_at
    FROM rebuttals r
    LEFT JOIN rebuttal_members rm ON rm.rebuttal_id = r.id AND rm.user_id = @uid
    WHERE r.owner_id = '' OR rm.user_id IS NOT NULL
    ORDER BY r.updated_at DESC
  `),

  getRebuttal: db.prepare(`SELECT * FROM rebuttals WHERE id = ?`),

  canAccess: db.prepare(`
    SELECT 1 FROM rebuttals r
    LEFT JOIN rebuttal_members rm ON rm.rebuttal_id = r.id AND rm.user_id = @uid
    WHERE r.id = @rid AND (r.owner_id = '' OR rm.user_id IS NOT NULL)
  `),

  isOwner: db.prepare(`
    SELECT 1 FROM rebuttal_members
    WHERE rebuttal_id = @rid AND user_id = @uid AND role = 'owner'
  `),

  insertRebuttal:  db.prepare(`INSERT INTO rebuttals (title, venue, owner_id, data) VALUES (@title, @venue, @owner_id, @data)`),
  updateRebuttal:  db.prepare(`UPDATE rebuttals SET title=@title, venue=@venue, data=@data, updated_at=datetime('now') WHERE id=@id`),
  deleteRebuttal:  db.prepare(`DELETE FROM rebuttals WHERE id = ?`),

  insertMember:    db.prepare(`INSERT OR IGNORE INTO rebuttal_members (rebuttal_id, user_id, role) VALUES (@rebuttal_id, @user_id, @role)`),
  getMembers:      db.prepare(`SELECT user_id, role FROM rebuttal_members WHERE rebuttal_id = ?`),
  removeMember:    db.prepare(`DELETE FROM rebuttal_members WHERE rebuttal_id = @rid AND user_id = @uid`),

  insertHistory:   db.prepare(`INSERT INTO history (rebuttal_id, note, data) VALUES (@rebuttal_id, @note, @data)`),
  listHistory:     db.prepare(`SELECT id, rebuttal_id, snapshot_at, note FROM history WHERE rebuttal_id=? ORDER BY snapshot_at DESC`),
  getSnapshot:     db.prepare(`SELECT * FROM history WHERE id=?`),
  deleteSnapshot:  db.prepare(`DELETE FROM history WHERE id=?`),
  pruneHistory:    db.prepare(`
    DELETE FROM history WHERE rebuttal_id=@rid AND id NOT IN (
      SELECT id FROM history WHERE rebuttal_id=@rid ORDER BY snapshot_at DESC LIMIT @keep
    )
  `),

  insertInvite:    db.prepare(`INSERT INTO invites (token, rebuttal_id, created_by, expires_at) VALUES (@token, @rebuttal_id, @created_by, @expires_at)`),
  getInvite:       db.prepare(`SELECT * FROM invites WHERE token = ?`),
  markInviteUsed:  db.prepare(`UPDATE invites SET used = 1 WHERE token = ?`),
  deleteExpired:   db.prepare(`DELETE FROM invites WHERE expires_at < datetime('now')`),
};

const HISTORY_KEEP = 50;

// ── Live state (in-memory per open rebuttal) ─────────────────────────────────
const liveState = new Map<number, RebuttalData>();
const flushTimers = new Map<number, ReturnType<typeof setTimeout>>();

function getLiveState(rebId: number): RebuttalData | null {
  if (liveState.has(rebId)) return liveState.get(rebId)!;
  const row = stmts.getRebuttal.get(rebId) as RebuttalRow | undefined;
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  liveState.set(rebId, data);
  return data;
}

function schedulePersist(rebId: number): void {
  if (flushTimers.has(rebId)) clearTimeout(flushTimers.get(rebId)!);
  flushTimers.set(rebId, setTimeout(() => {
    const state = liveState.get(rebId);
    if (!state) return;
    const row = stmts.getRebuttal.get(rebId) as RebuttalRow | undefined;
    if (!row) return;
    stmts.updateRebuttal.run({
      id: rebId,
      title: state.paperTitle || row.title,
      venue: state.venue || row.venue,
      data: JSON.stringify(state),
    });
  }, 1500));
}

function applyPatch(obj: Record<string, unknown>, dotPath: string, value: unknown): boolean {
  const parts = dotPath.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') return false;
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}

// ── Peer colours ─────────────────────────────────────────────────────────────
const PEER_COLORS = ['#6c7ef8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#38bdf8', '#fb7185', '#4ade80'];
let colorIdx = 0;
function nextColor(): string { return PEER_COLORS[colorIdx++ % PEER_COLORS.length]; }

// ── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(server, {
  cors: { origin: '*' },
});

// Auth middleware for Socket.io
io.use(async (socket, next) => {
  if (SKIP_AUTH) {
    socket.data.userId = MOCK_USER_ID;
    return next();
  }
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
    socket.data.userId = payload.sub;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
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
    if (state) socket.emit('sync', { state });
    broadcastPresence(rebId);
  });

  socket.on('patch', (payload: FieldPatch) => {
    const rebId = socket.data.rebId;
    if (rebId === null) return;
    const state = getLiveState(rebId);
    if (!state) return;
    applyPatch(state as unknown as Record<string, unknown>, payload.path, payload.value);
    schedulePersist(rebId);
    socket.to(`reb:${rebId}`).emit('patch', payload);
  });

  socket.on('disconnect', () => {
    if (socket.data.rebId !== null) broadcastPresence(socket.data.rebId);
  });
});

function broadcastPresence(rebId: number): void {
  const room = io.sockets.adapter.rooms.get(`reb:${rebId}`);
  if (!room) return;
  const peers = [...room].map((sid) => {
    const s = io.sockets.sockets.get(sid);
    return { socketId: sid, color: s?.data.color ?? '#fff' };
  });
  io.to(`reb:${rebId}`).emit('presence', { peers });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// Serve @clerk/clerk-js from node_modules
app.get('/clerk.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'node_modules/@clerk/clerk-js/dist/clerk.browser.js'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Config endpoint (safe to be public) ──────────────────────────────────────
app.get('/api/config', (_req, res) => {
  const config: ClientConfig = {
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
    skipAuth: SKIP_AUTH,
  };
  res.json(config);
});

// ── API: Rebuttals ────────────────────────────────────────────────────────────
app.get('/api/rebuttals', requireUser, (req, res) => {
  const uid = getUserId(req);
  const rows = SKIP_AUTH
    ? (db.prepare(`SELECT id, title, venue, owner_id, created_at, updated_at FROM rebuttals ORDER BY updated_at DESC`).all() as RebuttalRow[])
    : (stmts.listRebuttals.all({ uid }) as RebuttalRow[]);
  res.json(rows);
});

app.get('/api/rebuttals/:id', requireUser, (req, res) => {
  const rebId = parseInt(req.params.id as string);
  const uid = getUserId(req);

  if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId, uid })) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const row = stmts.getRebuttal.get(rebId) as RebuttalRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const live = liveState.get(rebId);
  const data = live ?? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
  res.json({ ...row, data });
});

app.post('/api/rebuttals', requireUser, (req, res) => {
  const uid = getUserId(req);
  const { title = 'Untitled', venue = '', data = {} } = req.body as { title?: string; venue?: string; data?: RebuttalData };

  const result = stmts.insertRebuttal.run({ title, venue, owner_id: uid, data: JSON.stringify(data) });
  const rebId = result.lastInsertRowid as number;
  stmts.insertMember.run({ rebuttal_id: rebId, user_id: uid, role: 'owner' });

  const row = stmts.getRebuttal.get(rebId) as RebuttalRow;
  res.status(201).json({ ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data });
});

app.put('/api/rebuttals/:id', requireUser, (req, res) => {
  const rebId = parseInt(req.params.id as string);
  const uid = getUserId(req);

  if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId, uid })) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  const existing = stmts.getRebuttal.get(rebId) as RebuttalRow | undefined;
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const { title, venue, data, snapshot, snapshotNote = '' } = req.body as {
    title?: string; venue?: string; data?: RebuttalData;
    snapshot?: boolean; snapshotNote?: string;
  };

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
    if (data) liveState.set(rebId, data);
  })();

  const row = stmts.getRebuttal.get(rebId) as RebuttalRow;
  const live = liveState.get(rebId);
  res.json({ ...row, data: live ?? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) });
});

app.delete('/api/rebuttals/:id', requireUser, (req, res) => {
  const rebId = parseInt(req.params.id as string);
  const uid = getUserId(req);

  if (!SKIP_AUTH && !stmts.isOwner.get({ rid: rebId, uid })) {
    res.status(403).json({ error: 'Only the owner can delete' }); return;
  }

  liveState.delete(rebId);
  flushTimers.delete(rebId);
  stmts.deleteRebuttal.run(rebId);
  res.json({ ok: true });
});

// ── API: History ──────────────────────────────────────────────────────────────
app.get('/api/rebuttals/:id/history', requireUser, (req, res) => {
  const rebId = parseInt(req.params.id as string);
  const uid = getUserId(req);
  if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId, uid })) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  res.json(stmts.listHistory.all(rebId));
});

app.get('/api/history/:snapshotId', requireUser, (req, res) => {
  const row = stmts.getSnapshot.get(req.params.snapshotId) as ({ data: string } & Record<string, unknown>) | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...row, data: JSON.parse(row.data) });
});

app.post('/api/rebuttals/:id/history', requireUser, (req, res) => {
  const rebId = parseInt(req.params.id as string);
  const uid = getUserId(req);
  if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId, uid })) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  const existing = stmts.getRebuttal.get(rebId) as RebuttalRow | undefined;
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const { note = '' } = req.body as { note?: string };
  const live = liveState.get(rebId);
  const dataToSnap = live ? JSON.stringify(live) : (typeof existing.data === 'string' ? existing.data : JSON.stringify(existing.data));
  const result = stmts.insertHistory.run({ rebuttal_id: rebId, note, data: dataToSnap });
  stmts.pruneHistory.run({ rid: rebId, keep: HISTORY_KEEP });
  res.status(201).json({ id: result.lastInsertRowid, note });
});

app.delete('/api/history/:snapshotId', requireUser, (req, res) => {
  if (!stmts.getSnapshot.get(req.params.snapshotId)) {
    res.status(404).json({ error: 'Not found' }); return;
  }
  stmts.deleteSnapshot.run(req.params.snapshotId);
  res.json({ ok: true });
});

// ── API: Invites ──────────────────────────────────────────────────────────────
// Create an invite link for a rebuttal
app.post('/api/rebuttals/:id/invite', requireUser, (req, res) => {
  const rebId = parseInt(req.params.id as string);
  const uid = getUserId(req);

  if (!SKIP_AUTH && !stmts.canAccess.get({ rid: rebId, uid })) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }

  stmts.deleteExpired.run(); // housekeeping

  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();
  stmts.insertInvite.run({ token, rebuttal_id: rebId, created_by: uid, expires_at: expiresAt });

  const protocol = (Array.isArray(req.headers['x-forwarded-proto']) ? req.headers['x-forwarded-proto'][0] : req.headers['x-forwarded-proto']) ?? req.protocol;
  const host = (Array.isArray(req.headers['x-forwarded-host']) ? req.headers['x-forwarded-host'][0] : req.headers['x-forwarded-host']) ?? req.get('host');
  res.json({ token, url: `${protocol}://${host}/invite/${token}` });
});

// Accept an invite (called from the invite page after sign-in)
app.post('/api/invite/:token/accept', requireUser, (req, res) => {
  const uid = getUserId(req);
  const invite = stmts.getInvite.get(req.params.token) as InviteRow | undefined;

  if (!invite) { res.status(404).json({ error: 'Invalid or expired invite' }); return; }
  if (invite.used) { res.status(410).json({ error: 'Invite already used' }); return; }
  if (new Date(invite.expires_at) < new Date()) {
    res.status(410).json({ error: 'Invite expired' }); return;
  }

  stmts.insertMember.run({ rebuttal_id: invite.rebuttal_id, user_id: uid, role: 'editor' });
  stmts.markInviteUsed.run(invite.token);

  res.json({ rebuttal_id: invite.rebuttal_id });
});

// ── Invite landing page ───────────────────────────────────────────────────────
app.get('/invite/:token', (req, res) => {
  const token = req.params.token;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY ?? '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Join Rebuttal</title>
<script src="/clerk.js"></script>
<style>
  body { font-family: system-ui, sans-serif; background:#0f1117; color:#e2e8f0;
    display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .card { background:#1a1d27; border:1px solid #2e3250; border-radius:12px; padding:32px;
    max-width:400px; width:90%; text-align:center; }
  h2 { margin:0 0 8px; font-size:1.2rem; }
  p  { color:#7c84a3; font-size:0.88rem; margin:0 0 24px; }
  .msg { font-size:0.82rem; color:#7c84a3; margin-top:16px; }
</style>
</head>
<body>
<div class="card">
  <h2>You've been invited to collaborate</h2>
  <p>Sign in to join this rebuttal document.</p>
  <div id="clerk-sign-in"></div>
  <div id="msg" class="msg">Loading…</div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const SKIP_AUTH = ${JSON.stringify(SKIP_AUTH)};
const PUBLISHABLE_KEY = ${JSON.stringify(publishableKey)};

async function run() {
  const msg = document.getElementById('msg');

  if (SKIP_AUTH) {
    msg.textContent = 'Accepting invite…';
    const r = await fetch('/api/invite/' + TOKEN + '/accept', { method: 'POST' });
    const data = await r.json();
    if (r.ok) window.location.href = '/?r=' + data.rebuttal_id;
    else msg.textContent = 'Error: ' + data.error;
    return;
  }

  const clerk = new Clerk(PUBLISHABLE_KEY);
  await clerk.load();

  if (!clerk.user) {
    msg.textContent = '';
    clerk.mountSignIn(document.getElementById('clerk-sign-in'), {
      afterSignInUrl: '/invite/' + TOKEN,
      afterSignUpUrl: '/invite/' + TOKEN,
    });
    return;
  }

  msg.textContent = 'Accepting invite…';
  const token = await clerk.session.getToken();
  const r = await fetch('/api/invite/' + TOKEN + '/accept', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
  });
  const data = await r.json();
  if (r.ok) window.location.href = '/?r=' + data.rebuttal_id;
  else msg.textContent = 'Error: ' + data.error;
}

run().catch(e => { document.getElementById('msg').textContent = e.message; });
</script>
</body>
</html>`);
});

// ── Serve frontend ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

server.listen(PORT, () => {
  const mode = SKIP_AUTH ? 'no-auth (SKIP_AUTH=true)' : 'Clerk auth';
  console.log(`Rebuttal UI → http://localhost:${PORT}  [${mode}]`);
});
