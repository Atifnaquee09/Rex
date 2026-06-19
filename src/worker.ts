import { config } from "./config.ts";
import {
  claimNextQueuedTicket,
  createRun,
  finishRun,
  addEvent,
  updateTicketStatus,
} from "./db.ts";
import { runTicket } from "./rex.ts";
import { runScript } from "./scripts.ts";
import { notifySlack } from "./slack.ts";
import type { Ticket } from "./types.ts";

/** Run the ticket's verification command in the workspace; log the outcome. */
async function verifyTicket(ticket: Ticket, runId: number): Promise<boolean> {
  addEvent(ticket.id, runId, "system", `Verifying: \`${ticket.verify_cmd}\``);
  const res = await runScript(ticket.verify_cmd);
  const ok = res.exit_code === 0 && !res.timed_out;
  addEvent(
    ticket.id,
    runId,
    ok ? "result" : "error",
    `Verification ${ok ? "PASSED ✅" : "FAILED ❌"} (exit ${res.exit_code}${res.timed_out ? ", timed out" : ""})\n${(res.stdout + "\n" + res.stderr).trim().slice(-1500)}`,
  );
  return ok;
}

const POLL_MS = 3000;
let running = false;

async function processTicket(ticket: Ticket): Promise<void> {
  const run = createRun(ticket.id, config.model);
  addEvent(ticket.id, run.id, "system", `Rex started work on ticket #${ticket.id} (model: ${config.model}).`);
  await notifySlack(ticket, `:hammer_and_wrench: Rex picked up *#${ticket.id} — ${ticket.title}* and is working on it.`);

  const sink = (type: any, content: string) => addEvent(ticket.id, run.id, type, content);
  const outcome = await runTicket(ticket, run.id, sink);

  // Verification gate: if the ticket has a check, run it. On failure, give Rex one fix-up pass.
  let verified: boolean | null = null; // null = no verify_cmd
  if (outcome.ok && ticket.verify_cmd.trim()) {
    verified = await verifyTicket(ticket, run.id);
    if (!verified) {
      addEvent(ticket.id, run.id, "system", "Verification failed — Rex is attempting a fix.");
      const fixTicket: Ticket = {
        ...ticket,
        description: `${ticket.description}\n\nIMPORTANT: your previous change FAILED the verification command \`${ticket.verify_cmd}\`. Investigate the failure in the repo and fix the code so that command passes.`,
      };
      const fix = await runTicket(fixTicket, run.id, sink);
      outcome.input_tokens += fix.input_tokens;
      outcome.output_tokens += fix.output_tokens;
      outcome.cache_read_tokens += fix.cache_read_tokens;
      outcome.cache_creation_tokens += fix.cache_creation_tokens;
      outcome.cost_usd += fix.cost_usd;
      outcome.num_turns += fix.num_turns;
      if (fix.summary) outcome.summary = fix.summary;
      verified = await verifyTicket(ticket, run.id);
    }
  }

  const finalOk = outcome.ok && verified !== false;
  finishRun(run.id, {
    status: finalOk ? "done" : "failed",
    input_tokens: outcome.input_tokens,
    output_tokens: outcome.output_tokens,
    cache_read_tokens: outcome.cache_read_tokens,
    cache_creation_tokens: outcome.cache_creation_tokens,
    cost_usd: outcome.cost_usd,
    num_turns: outcome.num_turns,
    result_summary: outcome.summary,
  });

  // Verified work lands in "In Review"; unverified/failed goes back to "To Do".
  updateTicketStatus(ticket.id, finalOk ? "in_review" : "todo");

  const tokens = outcome.input_tokens + outcome.output_tokens;
  const vtag = verified === null ? "" : verified ? " · ✅ verified" : " · ❌ verification failed";
  const verb = finalOk ? ":white_check_mark: Done (in review)" : ":x: Failed";
  await notifySlack(
    ticket,
    `${verb}${vtag} — *#${ticket.id}*\n${truncate(outcome.summary, 1500)}\n_Tokens: ${tokens.toLocaleString()} · Cost: $${outcome.cost_usd.toFixed(4)}_`,
  );
}

async function tick(): Promise<void> {
  if (running) return;
  const ticket = claimNextQueuedTicket();
  if (!ticket) return;
  running = true;
  try {
    await processTicket(ticket);
  } catch (err) {
    addEvent(ticket.id, null, "error", `Worker error: ${err instanceof Error ? err.message : String(err)}`);
    updateTicketStatus(ticket.id, "todo");
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
