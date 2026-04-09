const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'rebuttals.db');

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
  listRebuttals:   db.prepare(`SELECT id, title, venue, created_at, updated_at FROM rebuttals ORDER BY updated_at DESC`),
  getRebuttal:     db.prepare(`SELECT * FROM rebuttals WHERE id = ?`),
  insertRebuttal:  db.prepare(`INSERT INTO rebuttals (title, venue, data) VALUES (@title, @venue, @data)`),
  updateRebuttal:  db.prepare(`UPDATE rebuttals SET title=@title, venue=@venue, data=@data, updated_at=datetime('now') WHERE id=@id`),
  deleteRebuttal:  db.prepare(`DELETE FROM rebuttals WHERE id = ?`),

  insertHistory:   db.prepare(`INSERT INTO history (rebuttal_id, note, data) VALUES (@rebuttal_id, @note, @data)`),
  listHistory:     db.prepare(`SELECT id, rebuttal_id, snapshot_at, note FROM history WHERE rebuttal_id=? ORDER BY snapshot_at DESC`),
  getSnapshot:     db.prepare(`SELECT * FROM history WHERE id=?`),
  deleteSnapshot:  db.prepare(`DELETE FROM history WHERE id=?`),
  pruneHistory:    db.prepare(`
    DELETE FROM history WHERE rebuttal_id=@rid AND id NOT IN (
      SELECT id FROM history WHERE rebuttal_id=@rid ORDER BY snapshot_at DESC LIMIT @keep
    )
  `),
};

const HISTORY_KEEP = 50; // max snapshots per rebuttal

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Rebuttals ──────────────────────────────────────────────────────────

// List all rebuttals (summary, no data blob)
app.get('/api/rebuttals', (req, res) => {
  res.json(stmts.listRebuttals.all());
});

// Get one rebuttal (full data)
app.get('/api/rebuttals/:id', (req, res) => {
  const row = stmts.getRebuttal.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.data = JSON.parse(row.data);
  res.json(row);
});

// Create new rebuttal
app.post('/api/rebuttals', (req, res) => {
  const { title = 'Untitled', venue = '', data = {} } = req.body;
  const result = stmts.insertRebuttal.run({ title, venue, data: JSON.stringify(data) });
  const row = stmts.getRebuttal.get(result.lastInsertRowid);
  row.data = JSON.parse(row.data);
  res.status(201).json(row);
});

// Update rebuttal (auto-snapshot if requested)
app.put('/api/rebuttals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = stmts.getRebuttal.get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { title, venue, data, snapshot, snapshotNote = '' } = req.body;

  const saveSnapshot = db.transaction(() => {
    if (snapshot) {
      stmts.insertHistory.run({ rebuttal_id: id, note: snapshotNote, data: existing.data });
      stmts.pruneHistory.run({ rid: id, keep: HISTORY_KEEP });
    }
    stmts.updateRebuttal.run({
      id,
      title: title ?? JSON.parse(existing.data)?.paperTitle ?? existing.title,
      venue: venue ?? existing.venue,
      data: JSON.stringify(data ?? JSON.parse(existing.data)),
    });
  });
  saveSnapshot();

  const row = stmts.getRebuttal.get(id);
  row.data = JSON.parse(row.data);
  res.json(row);
});

// Delete rebuttal
app.delete('/api/rebuttals/:id', (req, res) => {
  const row = stmts.getRebuttal.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  stmts.deleteRebuttal.run(req.params.id);
  res.json({ ok: true });
});

// ── API: History ────────────────────────────────────────────────────────────

// List snapshots for a rebuttal
app.get('/api/rebuttals/:id/history', (req, res) => {
  const rows = stmts.listHistory.all(req.params.id);
  res.json(rows);
});

// Get a specific snapshot (full data)
app.get('/api/history/:snapshotId', (req, res) => {
  const row = stmts.getSnapshot.get(req.params.snapshotId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.data = JSON.parse(row.data);
  res.json(row);
});

// Manually create snapshot
app.post('/api/rebuttals/:id/history', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = stmts.getRebuttal.get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { note = '' } = req.body;
  const result = stmts.insertHistory.run({ rebuttal_id: id, note, data: existing.data });
  stmts.pruneHistory.run({ rid: id, keep: HISTORY_KEEP });
  res.status(201).json({ id: result.lastInsertRowid, note });
});

// Delete a snapshot
app.delete('/api/history/:snapshotId', (req, res) => {
  const row = stmts.getSnapshot.get(req.params.snapshotId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  stmts.deleteSnapshot.run(req.params.snapshotId);
  res.json({ ok: true });
});

// ── Serve frontend ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Rebuttal UI → http://localhost:${PORT}`);
});
