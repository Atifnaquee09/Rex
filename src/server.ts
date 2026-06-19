import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import {
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  setQueued,
  listEvents,
  listRunsForTicket,
  stats,
  createScript,
  getScript,
  listScripts,
  updateScript,
  deleteScript,
  addScriptRun,
  listScriptRuns,
  allSettings,
  setSetting,
  createPerson,
  getPerson,
  listPeople,
  updatePerson,
  deletePerson,
} from "./db.ts";
import { runScript } from "./scripts.ts";
import { kbEnabled, addKnowledge, listKnowledge, searchKnowledge, deleteKnowledge } from "./knowledge.ts";
import { chatReply, writeBrainFile } from "./rex.ts";
import { getArtifact, listArtifacts, type Artifact } from "./artifacts.ts";
import { startResearch } from "./research.ts";
import type { PersonRole } from "./types.ts";

const ROLES: PersonRole[] = ["exec", "business", "technical"];

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const TYPES = ["task", "bug", "feature"];

const htmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function shell(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${htmlEsc(title)}</title>${head}
<style>body{margin:0;background:#0a0a0a;color:#d4d4d8;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6}
.wrap{max-width:820px;margin:0 auto;padding:40px 24px}
.bar{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.logo{height:34px;width:34px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#d946ef);display:grid;place-items:center;font-weight:900;color:#fff}
.muted{color:#71717a;font-size:13px} h1,h2,h3{color:#fff;line-height:1.3} h1{font-size:1.7rem} h2{font-size:1.3rem;margin-top:1.6em;border-top:1px solid #27272a;padding-top:.8em} h3{font-size:1.1rem}
a{color:#818cf8} code{background:#18181b;border:1px solid #27272a;border-radius:4px;padding:1px 5px;font-family:ui-monospace,Menlo,monospace;font-size:.9em}
pre{background:#000;border:1px solid #27272a;border-radius:8px;padding:14px;overflow:auto} pre code{border:0;background:none;padding:0}
ul,ol{padding-left:22px} blockquote{border-left:3px solid #3f3f46;padding-left:12px;color:#a1a1aa;margin:.6em 0}
table{border-collapse:collapse;width:100%;margin:1em 0} th,td{border:1px solid #27272a;padding:6px 10px;text-align:left} th{background:#18181b;color:#fff}
hr{border:0;border-top:1px solid #27272a;margin:2em 0}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function renderArtifactPage(a?: Artifact): string {
  if (!a) {
    return shell("Expired", `<div class="bar"><div class="logo">R</div><strong>Rex</strong></div>
      <h1>Link not found or expired</h1><p class="muted">Reports are available for 24 hours, then they're deleted.</p>`);
  }
  if (a.status === "error") {
    return shell("Research failed", `<div class="bar"><div class="logo">R</div><strong>Rex</strong></div>
      <h1>Research failed</h1><pre>${htmlEsc(a.content_md)}</pre>`);
  }
  if (a.status === "pending") {
    return shell(
      "Researching…",
      `<div class="bar"><div class="logo">R</div><strong>Rex</strong></div>
       <h1>Researching…</h1>
       <p class="muted">Rex is searching the web and writing your report on:</p>
       <p><strong>${htmlEsc(a.query)}</strong></p>
       <p class="muted">This page refreshes itself — usually ready in a few minutes.</p>`,
      `<meta http-equiv="refresh" content="8">`,
    );
  }
  // ready — render the markdown client-side (sanitised), from a base64 blob (no injection breakout).
  const b64 = Buffer.from(a.content_md, "utf8").toString("base64");
  const expires = a.expires_at;
  return shell(
    a.title || "Research report",
    `<div class="bar"><div class="logo">R</div><strong>Rex</strong><span class="muted">· research</span></div>
     <p class="muted">Generated ${htmlEsc(a.created_at)} UTC · link expires ${htmlEsc(expires)} UTC</p>
     <div id="report">Rendering…</div>`,
    `<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
     <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
     <script>
       const md = new TextDecoder().decode(Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0)));
       document.getElementById("report").innerHTML = DOMPurify.sanitize(marked.parse(md));
     </script>`,
  );
}

export function startServer(): void {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, "..", "public")));

  // List tickets
  app.get("/api/tickets", (_req, res) => {
    res.json(listTickets());
  });

  // Create ticket (optionally queue it for Rex immediately)
  app.post("/api/tickets", (req, res) => {
    const { title, description, assign, priority, type, assignee, verify_cmd, max_turns } = req.body ?? {};
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const ticket = createTicket({
      title: title.trim(),
      description: typeof description === "string" ? description : "",
      priority: PRIORITIES.includes(priority) ? priority : "medium",
      type: TYPES.includes(type) ? type : "task",
      assignee: typeof assignee === "string" ? assignee.trim() : "",
      verify_cmd: typeof verify_cmd === "string" ? verify_cmd.trim() : "",
      max_turns: Number.isFinite(max_turns) ? Math.max(0, Math.min(200, Number(max_turns))) : 0,
      source: "dashboard",
      created_by: "dashboard",
      status: "todo",
      queued: Boolean(assign),
    });
    res.status(201).json(ticket);
  });

  // Update ticket fields (board move, priority, type, assignee)
  app.patch("/api/tickets/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!getTicket(id)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const { status, priority, type, assignee, verify_cmd, max_turns } = req.body ?? {};
    const fields: Record<string, string | number> = {};
    if (typeof status === "string" && STATUSES.includes(status)) fields.status = status;
    if (typeof priority === "string" && PRIORITIES.includes(priority)) fields.priority = priority;
    if (typeof type === "string" && TYPES.includes(type)) fields.type = type;
    if (typeof assignee === "string") fields.assignee = assignee.trim();
    if (typeof verify_cmd === "string") fields.verify_cmd = verify_cmd.trim();
    if (Number.isFinite(max_turns)) fields.max_turns = Math.max(0, Math.min(200, Number(max_turns)));
    res.json(updateTicket(id, fields as any));
  });

  // Ticket detail + events + runs
  app.get("/api/tickets/:id", (req, res) => {
    const id = Number(req.params.id);
    const ticket = getTicket(id);
    if (!ticket) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const afterId = Number(req.query.afterEvent ?? 0);
    res.json({ ticket, events: listEvents(id, afterId), runs: listRunsForTicket(id) });
  });

  // Run a ticket with Rex (queue it for the worker)
  app.post("/api/tickets/:id/run", (req, res) => {
    const id = Number(req.params.id);
    const ticket = getTicket(id);
    if (!ticket) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (ticket.status === "in_progress") {
      res.status(409).json({ error: "already in progress" });
      return;
    }
    setQueued(id, true);
    res.json(getTicket(id));
  });

  // Token burn + cost + counts
  app.get("/api/stats", (_req, res) => {
    res.json(stats());
  });

  // --- Research → time-boxed artifact pages ---

  app.post("/api/research", (req, res) => {
    const q = (req.body?.query ?? "").toString().trim();
    if (!q) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const id = startResearch(q);
    res.status(201).json({ id, url: `${config.publicUrl}/r/${id}` });
  });

  app.get("/api/artifacts", (_req, res) => {
    res.json(listArtifacts());
  });

  // Public, shareable artifact page (nginx serves /r/ without Basic Auth).
  app.get("/r/:id", (req, res) => {
    const a = getArtifact(req.params.id);
    res.type("html").status(a ? 200 : 404).send(renderArtifactPage(a));
  });

  // Terminal chat — plain text in, plain text out (used by the `rex` CLI).
  app.post("/api/chat", express.text({ type: "*/*", limit: "100kb" }), async (req, res) => {
    const msg = typeof req.body === "string" ? req.body.trim() : "";
    if (!msg) {
      res.type("text/plain").send("(empty message)");
      return;
    }
    try {
      res.type("text/plain").send(await chatReply(msg));
    } catch {
      res.type("text/plain").send("Rex hit an error. Try again.");
    }
  });

  // --- Shell scripts ---

  app.get("/api/scripts", (_req, res) => {
    res.json(listScripts());
  });

  app.post("/api/scripts", (req, res) => {
    const { name, description, body } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    res.status(201).json(createScript({ name: name.trim(), description: description ?? "", body: body ?? "" }));
  });

  app.get("/api/scripts/:id", (req, res) => {
    const script = getScript(Number(req.params.id));
    if (!script) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ script, runs: listScriptRuns(script.id) });
  });

  app.put("/api/scripts/:id", (req, res) => {
    const { name, description, body } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const updated = updateScript(Number(req.params.id), { name: name.trim(), description: description ?? "", body: body ?? "" });
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(updated);
  });

  app.delete("/api/scripts/:id", (req, res) => {
    deleteScript(Number(req.params.id));
    res.json({ ok: true });
  });

  // --- Knowledge base (pgvector semantic search) ---

  app.get("/api/knowledge", async (_req, res) => {
    if (!kbEnabled) {
      res.json({ enabled: false, items: [] });
      return;
    }
    res.json({ enabled: true, items: await listKnowledge() });
  });

  app.post("/api/knowledge", async (req, res) => {
    if (!kbEnabled) {
      res.status(503).json({ error: "knowledge base not configured" });
      return;
    }
    const { content, source } = req.body ?? {};
    if (!content || typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    res.status(201).json(await addKnowledge(content.trim(), typeof source === "string" ? source : "manual"));
  });

  app.post("/api/knowledge/search", async (req, res) => {
    if (!kbEnabled) {
      res.json({ results: [] });
      return;
    }
    const { query } = req.body ?? {};
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "query is required" });
      return;
    }
    res.json({ results: await searchKnowledge(query.trim(), 8) });
  });

  app.delete("/api/knowledge/:id", async (req, res) => {
    if (kbEnabled) await deleteKnowledge(Number(req.params.id));
    res.json({ ok: true });
  });

  // Execute a saved script (runs as the rex user, 60s timeout, output capped)
  app.post("/api/scripts/:id/run", async (req, res) => {
    const script = getScript(Number(req.params.id));
    if (!script) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const result = await runScript(script.body);
    const run = addScriptRun({ script_id: script.id, ...result });
    res.json(run);
  });

  // --- Settings (persona, standards) ---

  app.get("/api/settings", (_req, res) => {
    res.json(allSettings());
  });

  app.put("/api/settings", (req, res) => {
    const body = req.body ?? {};
    for (const key of ["persona", "standards", "slack_updates_channel"]) {
      if (typeof body[key] === "string") setSetting(key, body[key]);
    }
    if (typeof body.persona === "string") writeBrainFile(); // keep the terminal brain in sync
    res.json(allSettings());
  });

  // --- Team profiles ---

  const parsePerson = (b: any) => ({
    name: String(b?.name ?? "").trim(),
    title: typeof b?.title === "string" ? b.title.trim() : "",
    role: (ROLES.includes(b?.role) ? b.role : "technical") as PersonRole,
    slack_user_id: b?.slack_user_id ? String(b.slack_user_id).trim() : null,
    notes: typeof b?.notes === "string" ? b.notes : "",
  });

  app.get("/api/people", (_req, res) => {
    res.json(listPeople());
  });

  app.post("/api/people", (req, res) => {
    const p = parsePerson(req.body);
    if (!p.name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    try {
      res.status(201).json(createPerson(p));
    } catch {
      res.status(409).json({ error: "that Slack user ID is already mapped to someone" });
    }
  });

  app.put("/api/people/:id", (req, res) => {
    if (!getPerson(Number(req.params.id))) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const p = parsePerson(req.body);
    if (!p.name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    try {
      res.json(updatePerson(Number(req.params.id), p));
    } catch {
      res.status(409).json({ error: "that Slack user ID is already mapped to someone" });
    }
  });

  app.delete("/api/people/:id", (req, res) => {
    deletePerson(Number(req.params.id));
    res.json({ ok: true });
  });

  app.listen(config.port, config.host, () => {
    console.log(`[server] dashboard on http://${config.host}:${config.port}`);
  });
}
