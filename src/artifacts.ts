import { randomBytes } from "node:crypto";
import { db } from "./db.ts";

// Generic, time-boxed outputs (research reports, plans, …) served at /r/<id>.
// The shape is reused by every "agent produces something to show" capability.
db.exec(`
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    query TEXT NOT NULL DEFAULT '',
    content_md TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

export type ArtifactStatus = "pending" | "ready" | "error";

export interface Artifact {
  id: string;
  kind: string;
  title: string;
  status: ArtifactStatus;
  query: string;
  content_md: string;
  created_at: string;
  expires_at: string;
}

export function createArtifact(input: { kind: string; title: string; query: string; ttlHours?: number }): string {
  const id = randomBytes(16).toString("hex");
  db.prepare(
    "INSERT INTO artifacts (id, kind, title, query, status, expires_at) VALUES (?, ?, ?, ?, 'pending', datetime('now', ?))",
  ).run(id, input.kind, input.title, input.query, `+${Math.max(1, input.ttlHours ?? 24)} hours`);
  return id;
}

export function setArtifact(id: string, fields: { status?: ArtifactStatus; title?: string; content_md?: string }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["status", "title", "content_md"] as const) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as any[]));
}

/** Fetch a non-expired artifact. */
export function getArtifact(id: string): Artifact | undefined {
  return db
    .prepare("SELECT * FROM artifacts WHERE id = ? AND expires_at > datetime('now')")
    .get(id) as unknown as Artifact | undefined;
}

export function listArtifacts(limit = 30): Artifact[] {
  return db
    .prepare("SELECT id, kind, title, status, created_at, expires_at FROM artifacts WHERE expires_at > datetime('now') ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as Artifact[];
}

export function sweepExpiredArtifacts(): number {
  const res = db.prepare("DELETE FROM artifacts WHERE expires_at <= datetime('now')").run();
  return Number(res.changes ?? 0);
}

// Sweep hourly so expired links (and their content) are actually gone.
setInterval(() => {
  try {
    const n = sweepExpiredArtifacts();
    if (n) console.log(`[artifacts] swept ${n} expired`);
  } catch {
    /* ignore */
  }
}, 3_600_000);
