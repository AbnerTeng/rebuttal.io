import express from 'express';
import http from 'http';
import path from 'path';
import Database from 'better-sqlite3';
import { Server } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  FieldPatch,
  RebuttalData,
} from './types.js';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'rebuttals.db');

// ── Database setup ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS rebuttals (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT    NOT NULL DEFAULT 'Untitled',
    venue     TEXT    NOT NULL DEFAULT '',
    created_at TEXT   NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT   NOT NULL DEFAULT (datetime('now')),
    data      TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rebuttal_id INTEGER NOT NULL REFERENCES rebuttals(id) ON DELETE CASCADE,
    snapshot_at TEXT    NOT NULL DEFAULT (datetime('now')),
    note        TEXT    NOT NULL DEFAULT '',
    data        TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_history_rebuttal ON history(rebuttal_id, snapshot_at DESC);
`);

// ── Prepared statements ─────────────────────────────────────────────────────
const stmts = {
  listRebuttals:  db.prepare(`SELECT id, title, venue, created_at, updated_at FROM rebuttals ORDER BY updated_at DESC`),
  getRebuttal:    db.prepare(`SELECT * FROM rebuttals WHERE id = ?`),
  insertRebuttal: db.prepare(`INSERT INTO rebuttals (title, venue, data) VALUES (@title, @venue, @data)`),
  updateRebuttal: db.prepare(`UPDATE rebuttals SET title=@title, venue=@venue, data=@data, updated_at=datetime('now') WHERE id=@id`),
  deleteRebuttal: db.prepare(`DELETE FROM rebuttals WHERE id = ?`),

  insertHistory:  db.prepare(`INSERT INTO history (rebuttal_id, note, data) VALUES (@rebuttal_id, @note, @data)`),
  listHistory:    db.prepare(`SELECT id, rebuttal_id, snapshot_at, note FROM history WHERE rebuttal_id=? ORDER BY snapshot_at DESC`),
  getSnapshot:    db.prepare(`SELECT * FROM history WHERE id=?`),
  deleteSnapshot: db.prepare(`DELETE FROM history WHERE id=?`),
  pruneHistory:   db.prepare(`
    DELETE FROM history WHERE rebuttal_id=@rid AND id NOT IN (
      SELECT id FROM history WHERE rebuttal_id=@rid ORDER BY snapshot_at DESC LIMIT @keep
    )
  `),
};

const HISTORY_KEEP = 50;

// ── In-memory live state per rebuttal ────────────────────────────────────────
// Holds the current authoritative state for open documents.
// Flushed to SQLite on every patch (debounced per room).
const liveState = new Map<number, RebuttalData>();
const flushTimers = new Map<number, ReturnType<typeof setTimeout>>();

function getLiveState(rebId: number): RebuttalData | null {
  if (liveState.has(rebId)) return liveState.get(rebId)!;
  const row = stmts.getRebuttal.get(rebId) as { data: string; title: string; venue: string } | undefined;
  if (!row) return null;
  const data = JSON.parse(row.data) as RebuttalData;
  liveState.set(rebId, data);
  return data;
}

function schedulePersist(rebId: number): void {
  if (flushTimers.has(rebId)) clearTimeout(flushTimers.get(rebId)!);
  flushTimers.set(rebId, setTimeout(() => {
    const state = liveState.get(rebId);
    if (!state) return;
    const row = stmts.getRebuttal.get(rebId) as { title: string; venue: string } | undefined;
    if (!row) return;
    stmts.updateRebuttal.run({
      id: rebId,
      title: state.paperTitle || row.title,
      venue: state.venue || row.venue,
      data: JSON.stringify(state),
    });
  }, 1500));
}

/** Apply a dot-path patch to an object in-place. Returns true if applied. */
function applyPatch(obj: Record<string, unknown>, path: string, value: unknown): boolean {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur[key] === null || typeof cur[key] !== 'object') return false;
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}

// ── Peer colours (distinct per room) ─────────────────────────────────────────
const PEER_COLORS = ['#6c7ef8', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#38bdf8', '#fb7185', '#4ade80'];
let colorIdx = 0;
function nextColor(): string { return PEER_COLORS[colorIdx++ % PEER_COLORS.length]; }

// ── Socket.io ────────────────────────────────────────────────────────────────
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(server, {
  cors: { origin: '*' },
});

io.on('connection', (socket) => {
  socket.data.rebId = null;
  socket.data.color = nextColor();

  socket.on('join', (rebId) => {
    // Leave previous room if any
    if (socket.data.rebId !== null) {
      socket.leave(`reb:${socket.data.rebId}`);
      broadcastPresence(socket.data.rebId);
    }

    socket.data.rebId = rebId;
    socket.join(`reb:${rebId}`);

    // Send current state to the joining client
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

    // Broadcast to everyone else in the room
    socket.to(`reb:${rebId}`).emit('patch', payload);
  });

  socket.on('disconnect', () => {
    const rebId = socket.data.rebId;
    if (rebId !== null) broadcastPresence(rebId);
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

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API: Rebuttals ──────────────────────────────────────────────────────────
app.get('/api/rebuttals', (_req, res) => {
  res.json(stmts.listRebuttals.all());
});

app.get('/api/rebuttals/:id', (req, res) => {
  const row = stmts.getRebuttal.get(req.params.id) as { data: string } & Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  // Prefer live (in-memory) state if document is open
  const rebId = parseInt(req.params.id);
  const live = liveState.get(rebId);
  row.data = live ?? JSON.parse(row.data);
  res.json(row);
});

app.post('/api/rebuttals', (req, res) => {
  const { title = 'Untitled', venue = '', data = {} } = req.body as { title?: string; venue?: string; data?: RebuttalData };
  const result = stmts.insertRebuttal.run({ title, venue, data: JSON.stringify(data) });
  const row = stmts.getRebuttal.get(result.lastInsertRowid) as { data: string } & Record<string, unknown>;
  row.data = JSON.parse(row.data as string);
  res.status(201).json(row);
});

app.put('/api/rebuttals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = stmts.getRebuttal.get(id) as { data: string; title: string; venue: string } | undefined;
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const { title, venue, data, snapshot, snapshotNote = '' } = req.body as {
    title?: string; venue?: string; data?: RebuttalData;
    snapshot?: boolean; snapshotNote?: string;
  };

  const saveSnapshot = db.transaction(() => {
    if (snapshot) {
      stmts.insertHistory.run({ rebuttal_id: id, note: snapshotNote, data: existing.data });
      stmts.pruneHistory.run({ rid: id, keep: HISTORY_KEEP });
    }
    const resolvedData = data ?? JSON.parse(existing.data);
    stmts.updateRebuttal.run({
      id,
      title: title ?? resolvedData?.paperTitle ?? existing.title,
      venue: venue ?? existing.venue,
      data: JSON.stringify(resolvedData),
    });
    // Keep live state in sync
    if (data) liveState.set(id, data);
  });
  saveSnapshot();

  const row = stmts.getRebuttal.get(id) as { data: string } & Record<string, unknown>;
  row.data = liveState.get(id) ?? JSON.parse(row.data as string);
  res.json(row);
});

app.delete('/api/rebuttals/:id', (req, res) => {
  const row = stmts.getRebuttal.get(req.params.id);
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const rebId = parseInt(req.params.id);
  liveState.delete(rebId);
  flushTimers.delete(rebId);
  stmts.deleteRebuttal.run(req.params.id);
  res.json({ ok: true });
});

// ── API: History ────────────────────────────────────────────────────────────
app.get('/api/rebuttals/:id/history', (req, res) => {
  res.json(stmts.listHistory.all(req.params.id));
});

app.get('/api/history/:snapshotId', (req, res) => {
  const row = stmts.getSnapshot.get(req.params.snapshotId) as { data: string } & Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  row.data = JSON.parse(row.data as string);
  res.json(row);
});

app.post('/api/rebuttals/:id/history', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = stmts.getRebuttal.get(id);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const { note = '' } = req.body as { note?: string };
  // Snapshot from live state if available
  const live = liveState.get(id);
  const dataToSnap = live ? JSON.stringify(live) : (existing as { data: string }).data;
  const result = stmts.insertHistory.run({ rebuttal_id: id, note, data: dataToSnap });
  stmts.pruneHistory.run({ rid: id, keep: HISTORY_KEEP });
  res.status(201).json({ id: result.lastInsertRowid, note });
});

app.delete('/api/history/:snapshotId', (req, res) => {
  const row = stmts.getSnapshot.get(req.params.snapshotId);
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  stmts.deleteSnapshot.run(req.params.snapshotId);
  res.json({ ok: true });
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

server.listen(PORT, () => {
  console.log(`Rebuttal UI → http://localhost:${PORT}`);
});
