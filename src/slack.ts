import { App } from "@slack/bolt";
import { config } from "./config.ts";
import { createTicket } from "./db.ts";
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

async function handleWorkRequest(args: {
  text: string;
  channel: string;
  threadTs: string;
  user: string;
  say: (msg: any) => Promise<any>;
}): Promise<void> {
  const { title, description } = toTicket(args.text);
  if (!title) {
    await args.say({ thread_ts: args.threadTs, text: "Give me a ticket title, e.g. `@Rex Fix login redirect :: users land on 404 after SSO`." });
    return;
  }
  const ticket = createTicket({
    title,
    description,
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
    await handleWorkRequest({
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
    await handleWorkRequest({
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
