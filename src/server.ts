import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import {
  createTicket,
  getTicket,
  listTickets,
  updateTicketStatus,
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
import type { PersonRole } from "./types.ts";

const ROLES: PersonRole[] = ["exec", "business", "technical"];

const __dirname = dirname(fileURLToPath(import.meta.url));

export function startServer(): void {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, "..", "public")));

  // List tickets
  app.get("/api/tickets", (_req, res) => {
    res.json(listTickets());
  });

  // Create ticket (optionally auto-assign)
  app.post("/api/tickets", (req, res) => {
    const { title, description, assign } = req.body ?? {};
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const ticket = createTicket({
      title: title.trim(),
      description: typeof description === "string" ? description : "",
      source: "dashboard",
      created_by: "dashboard",
      status: assign ? "assigned" : "open",
    });
    res.status(201).json(ticket);
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

  // Assign a ticket to Rex (queue it)
  app.post("/api/tickets/:id/assign", (req, res) => {
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
    updateTicketStatus(id, "assigned");
    res.json(getTicket(id));
  });

  // Token burn + cost + counts
  app.get("/api/stats", (_req, res) => {
    res.json(stats());
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
    for (const key of ["persona", "standards"]) {
      if (typeof body[key] === "string") setSetting(key, body[key]);
    }
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
