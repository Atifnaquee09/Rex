import { DatabaseSync } from "node:sqlite";
import type { Ticket, TicketStatus, TicketSource, Run, RunStatus, TicketEvent, EventType, Script, ScriptRun } from "./types.ts";

const db = new DatabaseSync("rex.db");

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    source TEXT NOT NULL DEFAULT 'dashboard',
    created_by TEXT NOT NULL DEFAULT 'unknown',
    slack_channel TEXT,
    slack_thread_ts TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    model TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    num_turns INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    run_id INTEGER,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs(ticket_id);

  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS script_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER NOT NULL,
    exit_code INTEGER NOT NULL DEFAULT 0,
    stdout TEXT NOT NULL DEFAULT '',
    stderr TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    timed_out INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_scriptruns_script ON script_runs(script_id);
`);

// --- Tickets ---

export function createTicket(input: {
  title: string;
  description?: string;
  source?: TicketSource;
  created_by?: string;
  slack_channel?: string | null;
  slack_thread_ts?: string | null;
  status?: TicketStatus;
}): Ticket {
  const stmt = db.prepare(`
    INSERT INTO tickets (title, description, status, source, created_by, slack_channel, slack_thread_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    input.title,
    input.description ?? "",
    input.status ?? "open",
    input.source ?? "dashboard",
    input.created_by ?? "unknown",
    input.slack_channel ?? null,
    input.slack_thread_ts ?? null,
  );
  return getTicket(Number(info.lastInsertRowid))!;
}

export function getTicket(id: number): Ticket | undefined {
  return db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Ticket | undefined;
}

export function listTickets(): Ticket[] {
  return db.prepare("SELECT * FROM tickets ORDER BY id DESC").all() as unknown as Ticket[];
}

export function updateTicketStatus(id: number, status: TicketStatus): void {
  db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

/**
 * Atomically claim the oldest 'assigned' ticket and flip it to 'in_progress'.
 * Returns the claimed ticket or null. Single-worker safe.
 */
export function claimNextAssignedTicket(): Ticket | null {
  const row = db.prepare("SELECT * FROM tickets WHERE status = 'assigned' ORDER BY id ASC LIMIT 1").get() as
    | Ticket
    | undefined;
  if (!row) return null;
  const res = db
    .prepare("UPDATE tickets SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'assigned'")
    .run(row.id);
  if (res.changes === 0) return null; // lost the race
  return getTicket(row.id)!;
}

// --- Runs ---

export function createRun(ticket_id: number, model: string): Run {
  const info = db.prepare("INSERT INTO runs (ticket_id, model, status) VALUES (?, ?, 'running')").run(ticket_id, model);
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as Run;
}

export function finishRun(
  id: number,
  data: {
    status: RunStatus;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    num_turns: number;
    result_summary: string | null;
  },
): void {
  db.prepare(
    `UPDATE runs SET status = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
      cache_creation_tokens = ?, cost_usd = ?, num_turns = ?, result_summary = ?, finished_at = datetime('now')
     WHERE id = ?`,
  ).run(
    data.status,
    data.input_tokens,
    data.output_tokens,
    data.cache_read_tokens,
    data.cache_creation_tokens,
    data.cost_usd,
    data.num_turns,
    data.result_summary,
    id,
  );
}

export function listRunsForTicket(ticket_id: number): Run[] {
  return db.prepare("SELECT * FROM runs WHERE ticket_id = ? ORDER BY id ASC").all(ticket_id) as unknown as Run[];
}

// --- Events ---

export function addEvent(ticket_id: number, run_id: number | null, type: EventType, content: string): void {
  db.prepare("INSERT INTO events (ticket_id, run_id, type, content) VALUES (?, ?, ?, ?)").run(
    ticket_id,
    run_id,
    type,
    content,
  );
}

export function listEvents(ticket_id: number, afterId = 0): TicketEvent[] {
  return db
    .prepare("SELECT * FROM events WHERE ticket_id = ? AND id > ? ORDER BY id ASC")
    .all(ticket_id, afterId) as unknown as TicketEvent[];
}

// --- Stats ---

export function stats() {
  const totals = db
    .prepare(
      `SELECT
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cost_usd),0) AS cost_usd,
        COUNT(*) AS runs
       FROM runs`,
    )
    .get() as Record<string, number>;
  const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  return { totals, byStatus };
}

// --- Scripts ---

export function createScript(input: { name: string; description?: string; body: string }): Script {
  const info = db
    .prepare("INSERT INTO scripts (name, description, body) VALUES (?, ?, ?)")
    .run(input.name, input.description ?? "", input.body);
  return getScript(Number(info.lastInsertRowid))!;
}

export function getScript(id: number): Script | undefined {
  return db.prepare("SELECT * FROM scripts WHERE id = ?").get(id) as unknown as Script | undefined;
}

export function listScripts(): Script[] {
  return db.prepare("SELECT * FROM scripts ORDER BY name ASC").all() as unknown as Script[];
}

export function updateScript(id: number, input: { name: string; description?: string; body: string }): Script | undefined {
  db.prepare("UPDATE scripts SET name = ?, description = ?, body = ?, updated_at = datetime('now') WHERE id = ?").run(
    input.name,
    input.description ?? "",
    input.body,
    id,
  );
  return getScript(id);
}

export function deleteScript(id: number): void {
  db.prepare("DELETE FROM scripts WHERE id = ?").run(id);
  db.prepare("DELETE FROM script_runs WHERE script_id = ?").run(id);
}

export function addScriptRun(input: {
  script_id: number;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}): ScriptRun {
  const info = db
    .prepare(
      "INSERT INTO script_runs (script_id, exit_code, stdout, stderr, duration_ms, timed_out) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(input.script_id, input.exit_code, input.stdout, input.stderr, input.duration_ms, input.timed_out ? 1 : 0);
  return db.prepare("SELECT * FROM script_runs WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as ScriptRun;
}

export function listScriptRuns(script_id: number, limit = 20): ScriptRun[] {
  return db
    .prepare("SELECT * FROM script_runs WHERE script_id = ? ORDER BY id DESC LIMIT ?")
    .all(script_id, limit) as unknown as ScriptRun[];
}

export { db };
