// ── Domain types ─────────────────────────────────────────────────────────────

export type PointStatus = 'todo' | 'partial' | 'done';
export type PointType = 'weakness' | 'question' | 'other';
export type ReviewerScore = '' | '-2' | '-1' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10';

export interface Point {
  id: number;
  type: PointType;
  complaint: string;
  response: string;
  status: PointStatus;
}

export interface Reviewer {
  id: number;
  name: string;
  score: ReviewerScore;
  openingNote: string;
  points: Point[];
}

export interface RebuttalData {
  venue: string;
  paperTitle: string;
  reviewers: Reviewer[];
  activeId: number | null;
}

export interface RebuttalRow {
  id: number;
  title: string;
  venue: string;
  created_at: string;
  updated_at: string;
  data: RebuttalData;
}

// ── WebSocket event payloads ──────────────────────────────────────────────────

/** A single field-level patch emitted by any client. */
export interface FieldPatch {
  /** dot-notation path, e.g. "venue", "reviewers.0.score", "reviewers.0.points.1.response" */
  path: string;
  value: unknown;
  /** client-generated id to echo back so sender can skip re-applying its own patch */
  clientId: string;
}

/** Emitted by server to a newly joined client to sync current state. */
export interface SyncPayload {
  state: RebuttalData;
}

/** Server → all clients: a peer has joined or left. */
export interface PresencePayload {
  peers: PeerInfo[];
}

export interface PeerInfo {
  socketId: string;
  /** optional display name / cursor colour */
  color: string;
}

// ── Socket.io typed event maps ────────────────────────────────────────────────

export interface ServerToClientEvents {
  /** Full state sync on join */
  sync: (payload: SyncPayload) => void;
  /** Incremental field patch from another peer */
  patch: (payload: FieldPatch) => void;
  /** Peer list update */
  presence: (payload: PresencePayload) => void;
}

export interface ClientToServerEvents {
  /** Join a rebuttal room */
  join: (rebId: number) => void;
  /** Send a field-level patch */
  patch: (payload: FieldPatch) => void;
}

export interface InterServerEvents {}
export interface SocketData {
  rebId: number | null;
  color: string;
}
