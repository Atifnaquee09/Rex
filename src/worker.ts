import { config } from "./config.ts";
import {
  claimNextAssignedTicket,
  createRun,
  finishRun,
  addEvent,
  updateTicketStatus,
} from "./db.ts";
import { runTicket } from "./rex.ts";
import { notifySlack } from "./slack.ts";
import type { Ticket } from "./types.ts";

const POLL_MS = 3000;
let running = false;

async function processTicket(ticket: Ticket): Promise<void> {
  const run = createRun(ticket.id, config.model);
  addEvent(ticket.id, run.id, "system", `Rex started work on ticket #${ticket.id} (model: ${config.model}).`);
  await notifySlack(ticket, `:hammer_and_wrench: Rex picked up *#${ticket.id} — ${ticket.title}* and is working on it.`);

  const outcome = await runTicket(ticket, run.id, (type, content) => {
    addEvent(ticket.id, run.id, type, content);
  });

  finishRun(run.id, {
    status: outcome.ok ? "done" : "failed",
    input_tokens: outcome.input_tokens,
    output_tokens: outcome.output_tokens,
    cache_read_tokens: outcome.cache_read_tokens,
    cache_creation_tokens: outcome.cache_creation_tokens,
    cost_usd: outcome.cost_usd,
    num_turns: outcome.num_turns,
    result_summary: outcome.summary,
  });

  updateTicketStatus(ticket.id, outcome.ok ? "done" : "failed");

  const tokens = outcome.input_tokens + outcome.output_tokens;
  const verb = outcome.ok ? ":white_check_mark: Done" : ":x: Failed";
  await notifySlack(
    ticket,
    `${verb} — *#${ticket.id}*\n${truncate(outcome.summary, 1500)}\n_Tokens: ${tokens.toLocaleString()} · Cost: $${outcome.cost_usd.toFixed(4)}_`,
  );
}

async function tick(): Promise<void> {
  if (running) return;
  const ticket = claimNextAssignedTicket();
  if (!ticket) return;
  running = true;
  try {
    await processTicket(ticket);
  } catch (err) {
    addEvent(ticket.id, null, "error", `Worker error: ${err instanceof Error ? err.message : String(err)}`);
    updateTicketStatus(ticket.id, "failed");
  } finally {
    running = false;
  }
}

export function startWorker(): void {
  console.log(`[worker] polling for assigned tickets every ${POLL_MS}ms`);
  setInterval(() => {
    void tick();
  }, POLL_MS);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
