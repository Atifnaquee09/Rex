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
} from "./db.ts";

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

  app.listen(config.port, config.host, () => {
    console.log(`[server] dashboard on http://${config.host}:${config.port}`);
  });
}
