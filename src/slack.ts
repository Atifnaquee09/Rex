import { App } from "@slack/bolt";
import { config } from "./config.ts";
import { createTicket, getPersonBySlackId } from "./db.ts";
import { triage } from "./rex.ts";
import type { Ticket } from "./types.ts";

let app: App | null = null;

/**
 * Post an update to the Slack thread a ticket originated from (no-op if the
 * ticket wasn't created from Slack or Slack is disabled).
 */
export async function notifySlack(ticket: Ticket, text: string): Promise<void> {
  if (!app || !ticket.slack_channel) return;
  try {
    await app.client.chat.postMessage({
      channel: ticket.slack_channel,
      thread_ts: ticket.slack_thread_ts ?? undefined,
      text,
    });
  } catch (err) {
    console.error("[slack] notify failed:", err instanceof Error ? err.message : err);
  }
}

function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

/**
 * Parse a message into a ticket. "<title> :: <description>" splits title/desc;
 * otherwise the first line is the title and the rest is the description.
 */
function toTicket(raw: string): { title: string; description: string } {
  const text = stripMention(raw);
  if (text.includes("::")) {
    const [title, ...rest] = text.split("::");
    return { title: title.trim(), description: rest.join("::").trim() };
  }
  const lines = text.split("\n");
  return { title: lines[0].trim(), description: lines.slice(1).join("\n").trim() };
}

async function fileTicket(args: {
  title: string;
  description: string;
  channel: string;
  threadTs: string;
  user: string;
  say: (msg: any) => Promise<any>;
}): Promise<void> {
  const ticket = createTicket({
    title: args.title,
    description: args.description,
    source: "slack",
    created_by: args.user,
    slack_channel: args.channel,
    slack_thread_ts: args.threadTs,
    status: "assigned", // straight into the work queue
  });
  await args.say({
    thread_ts: args.threadTs,
    text: `:ticket: Filed *#${ticket.id} — ${ticket.title}* and queued it. I'll post progress in this thread.`,
  });
}

async function handleInbound(args: {
  text: string;
  channel: string;
  threadTs: string;
  user: string;
  say: (msg: any) => Promise<any>;
}): Promise<void> {
  const text = stripMention(args.text);
  if (!text) {
    await args.say({ thread_ts: args.threadTs, text: "Hey — I'm Rex. Tell me what to build or fix, or use `title :: description` to file work directly." });
    return;
  }

  // Explicit ticket syntax (contains "::") goes straight to a ticket — no triage needed.
  if (text.includes("::")) {
    const { title, description } = toTicket(args.text);
    await fileTicket({ ...args, title, description });
    return;
  }

  // Otherwise let Rex decide: real work -> ticket, conversation -> reply.
  // If we know who this is (team profile), pass their role so Rex adapts deterministically.
  const person = getPersonBySlackId(args.user);
  const profile = person ? { name: person.name, role: person.role, notes: person.notes } : undefined;
  const decision = await triage(text, profile);
  if (decision.kind === "chat") {
    await args.say({ thread_ts: args.threadTs, text: decision.reply });
    return;
  }
  await fileTicket({ ...args, title: decision.title, description: decision.description });
}

export async function startSlack(): Promise<void> {
  if (!config.slack.enabled) {
    console.log("[slack] disabled (no tokens set) — dashboard + worker still run");
    return;
  }

  app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  // @Rex in a channel
  app.event("app_mention", async ({ event, say }: any) => {
    const e = event as any;
    await handleInbound({
      text: e.text ?? "",
      channel: e.channel,
      threadTs: e.thread_ts ?? e.ts,
      user: e.user ?? "unknown",
      say,
    });
  });

  // Direct messages to Rex
  app.message(async ({ message, say }: any) => {
    const m = message as any;
    if (m.subtype || m.bot_id) return; // ignore bot/system messages
    if (m.channel_type !== "im") return; // only DMs here; channel use goes through app_mention
    await handleInbound({
      text: m.text ?? "",
      channel: m.channel,
      threadTs: m.thread_ts ?? m.ts,
      user: m.user ?? "unknown",
      say,
    });
  });

  await app.start();
  console.log("[slack] connected via Socket Mode");
}
