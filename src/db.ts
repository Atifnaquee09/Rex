import { DatabaseSync } from "node:sqlite";
import type {
  Ticket,
  TicketStatus,
  TicketPriority,
  TicketType,
  TicketSource,
  Run,
  RunStatus,
  TicketEvent,
  EventType,
  Script,
  ScriptRun,
  Person,
  PersonRole,
} from "./types.ts";

const db = new DatabaseSync("rex.db");

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    type TEXT NOT NULL DEFAULT 'task',
    assignee TEXT NOT NULL DEFAULT '',
    queued INTEGER NOT NULL DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_user_id TEXT UNIQUE,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'technical',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration for databases created before `title` existed.
try {
  db.exec("ALTER TABLE people ADD COLUMN title TEXT NOT NULL DEFAULT ''");
} catch {
  /* column already exists */
}

// Migrations for tickets created before the Jira-style fields existed.
for (const stmt of [
  "ALTER TABLE tickets ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'",
  "ALTER TABLE tickets ADD COLUMN type TEXT NOT NULL DEFAULT 'task'",
  "ALTER TABLE tickets ADD COLUMN assignee TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE tickets ADD COLUMN queued INTEGER NOT NULL DEFAULT 0",
]) {
  try {
    db.exec(stmt);
  } catch {
    /* column already exists */
  }
}
// Remap any legacy statuses to the new board columns.
try {
  db.exec("UPDATE tickets SET status='backlog' WHERE status='open'");
  db.exec("UPDATE tickets SET status='todo' WHERE status IN ('assigned','failed')");
} catch {
  /* ignore */
}

// --- Settings (key/value, with seeded defaults) ---

export const DEFAULT_PERSONA = `You are Rex, the CTO and senior technical leader on this team. You are a real human in
the conversation — never a bot. You understand the whole project, the people, and the
technical and business context behind every request.

How you behave:
1. READ THE CONVERSATION FIRST. Use the thread/context provided to understand what is actually
   being discussed — what was asked, by whom, and what the latest message means in that context.
   NEVER ask for context the conversation already makes obvious. NEVER reply generically.
2. ADAPT TO THE PERSON you're replying to (their role is given):
   - Designers / business / non-technical people: speak their language. Do NOT use engineering
     jargon (PR, deploy, CI, testing, merge) with them. Keep it about their work and the outcome.
   - Engineers / technical people: be precise and technical.
   You are the technical expert, so you always understand the engineering reality — but you only
   surface it to the people who need it.
3. DRIVE THE WORK FORWARD like a sharp CTO/PM. Acknowledge what they said, ask for the one right
   next thing, and loop in the right people. If someone delivers something another person asked
   for, get it to that person and @-mention them.

Example of the standard you must hit:
- A designer says "the wireframe is ready."
  GOOD: "Awesome, thanks! Drop the wireframe here and I'll review it, then get it in front of
        <whoever requested it> for sign-off."
  BAD (never do this): "Ready for what — PR review, deployment, testing? Give me context."
  (Robotic, technical, and ignores the conversation.)

Be warm, human, concise, and genuinely useful. You're the competent leader who keeps everyone moving.`;

export const DEFAULT_STANDARDS = `Engineering standards Rex follows when doing work:
- Start lean: build the minimum that solves the problem well. Complexity must earn its place.
- Read existing code before changing it; match the surrounding style.
- Security first: no injection, XSS, or OWASP top-10 issues.
- No speculative work or future-proofing that wasn't asked for.
- Done means demonstrated: verify the change and report how you verified it.`;

function seedSetting(key: string, value: string): void {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}
seedSetting("persona", DEFAULT_PERSONA);
seedSetting("standards", DEFAULT_STANDARDS);

export function getSetting(key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  ).run(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// --- People (team profiles) ---

export function createPerson(input: { name: string; title?: string; role: PersonRole; slack_user_id?: string | null; notes?: string }): Person {
  const info = db
    .prepare("INSERT INTO people (name, title, role, slack_user_id, notes) VALUES (?, ?, ?, ?, ?)")
    .run(input.name, input.title ?? "", input.role, input.slack_user_id || null, input.notes ?? "");
  return getPerson(Number(info.lastInsertRowid))!;
}

export function getPerson(id: number): Person | undefined {
  return db.prepare("SELECT * FROM people WHERE id = ?").get(id) as unknown as Person | undefined;
}

export function getPersonBySlackId(slackId: string): Person | undefined {
  return db.prepare("SELECT * FROM people WHERE slack_user_id = ?").get(slackId) as unknown as Person | undefined;
}

export function listPeople(): Person[] {
  return db.prepare("SELECT * FROM people ORDER BY name ASC").all() as unknown as Person[];
}

export function updatePerson(id: number, input: { name: string; title?: string; role: PersonRole; slack_user_id?: string | null; notes?: string }): Person | undefined {
  db.prepare(
    "UPDATE people SET name = ?, title = ?, role = ?, slack_user_id = ?, notes = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(input.name, input.title ?? "", input.role, input.slack_user_id || null, input.notes ?? "", id);
  return getPerson(id);
}

export function deletePerson(id: number): void {
  db.prepare("DELETE FROM people WHERE id = ?").run(id);
}

// --- Tickets ---

export function createTicket(input: {
  title: string;
  description?: string;
  source?: TicketSource;
  created_by?: string;
  slack_channel?: string | null;
  slack_thread_ts?: string | null;
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  assignee?: string;
  queued?: boolean;
}): Ticket {
  const stmt = db.prepare(`
    INSERT INTO tickets (title, description, status, priority, type, assignee, queued, source, created_by, slack_channel, slack_thread_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    input.title,
    input.description ?? "",
    input.status ?? "todo",
    input.priority ?? "medium",
    input.type ?? "task",
    input.assignee ?? "",
    input.queued ? 1 : 0,
    input.source ?? "dashboard",
    input.created_by ?? "unknown",
    input.slack_channel ?? null,
    input.slack_thread_ts ?? null,
  );
  return getTicket(Number(info.lastInsertRowid))!;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function updateTicket(
  id: number,
  fields: Partial<Pick<Ticket, "status" | "priority" | "type" | "assignee">>,
): Ticket | undefined {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["status", "priority", "type", "assignee"] as const) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return getTicket(id);
  vals.push(id);
  db.prepare(`UPDATE tickets SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...(vals as any[]));
  return getTicket(id);
}

/** Flag a ticket for Rex to pick up and execute. */
export function setQueued(id: number, queued = true): void {
  db.prepare("UPDATE tickets SET queued = ?, updated_at = datetime('now') WHERE id = ?").run(queued ? 1 : 0, id);
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
 * Atomically claim the highest-priority queued ticket and flip it to 'in_progress'.
 * Returns the claimed ticket or null. Single-worker safe.
 */
export function claimNextQueuedTicket(): Ticket | null {
  const row = db
    .prepare(
      `SELECT * FROM tickets WHERE queued = 1 AND status != 'in_progress'
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id ASC
       LIMIT 1`,
    )
    .get() as unknown as Ticket | undefined;
  if (!row) return null;
  const res = db
    .prepare("UPDATE tickets SET status = 'in_progress', queued = 0, updated_at = datetime('now') WHERE id = ? AND queued = 1")
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
