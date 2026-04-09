// ── Domain types ─────────────────────────────────────────────────────────────

export type PointStatus = 'todo' | 'partial' | 'done';
export type PointType = 'W' | 'Q' | 'C' | 'S';
export type ReviewerScore = string; // empty string = no score; any integer string otherwise
export type MemberRole = 'owner' | 'editor';

export interface Point {
  id: number;
  type: PointType;
  concern: string;
  response: string;
  status: PointStatus;
}

export interface Reviewer {
  id: number;
  name: string;
  score: ReviewerScore;
  opening: string;
  points: Point[];
}

export interface ScoreConfig {
  min: number;
  max: number;
  labels: Record<string, string>; // score value string → description
}

export interface RebuttalData {
  venue: string;
  paperTitle: string;
  reviewers: Reviewer[];
  activeId: number | null;
  scoreConfig?: ScoreConfig;
}

export interface RebuttalRow {
  id: number;
  title: string;
  venue: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  data: RebuttalData;
}

export interface InviteRow {
  token: string;
  rebuttal_id: number;
  created_by: string;
  expires_at: string;
  used: number;
}

// ── WebSocket event payloads ──────────────────────────────────────────────────

export interface FieldPatch {
  path: string;
  value: unknown;
  clientId: string;
}

export interface SyncPayload {
  state: RebuttalData;
}

export interface PresencePayload {
  peers: PeerInfo[];
}

export interface PeerInfo {
  socketId: string;
  color: string;
  name: string;
}

// ── Socket.io typed event maps ────────────────────────────────────────────────

export interface PeerFocusPayload {
  socketId: string;
  path: string | null; // null = blurred
}

export interface ServerToClientEvents {
  sync: (payload: SyncPayload) => void;
  patch: (payload: FieldPatch) => void;
  presence: (payload: PresencePayload) => void;
  peer_focus: (payload: PeerFocusPayload) => void;
}

export interface ClientToServerEvents {
  join: (rebId: number) => void;
  patch: (payload: FieldPatch) => void;
  focus: (payload: { path: string | null }) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  rebId: number | null;
  color: string;
  userId: string;
  name: string;
}

// ── Config payload sent to frontend ──────────────────────────────────────────

export interface ClientConfig {
  skipAuth: boolean;
}
