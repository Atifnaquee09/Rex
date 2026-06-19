import { App } from "@slack/bolt";
import { config } from "./config.ts";
import { createTicket, getPersonBySlackId, getSetting } from "./db.ts";
import { triage, parseAdminIntent, isTrivial, consideredReply } from "./rex.ts";
import { startResearch } from "./research.ts";
import type { Ticket } from "./types.ts";

let app: App | null = null;

// De-dupe Slack event redeliveries (Socket Mode can retry if an ack is slow). Without this,
// one message could be answered twice — or worse, file/execute a ticket twice.
const handledEvents = new Map<string, number>();
function alreadyHandled(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of handledEvents) if (now - t > 120_000) handledEvents.delete(k);
  if (handledEvents.has(key)) return true;
  handledEvents.set(key, now);
  return false;
}

/**
 * Post an update to the Slack thread a ticket originated from (no-op if the
 * ticket wasn't created from Slack or Slack is disabled).
 */
export async function notifySlack(ticket: Ticket, text: string): Promise<void> {
  if (!app) return;
  // Slack-originated tickets reply in their thread; everything else (dashboard tickets)
  // goes to the configured updates channel so you still get notified.
  const channel = ticket.slack_channel || getSetting("slack_updates_channel", "").trim();
  if (!channel) return;
  const thread_ts = ticket.slack_channel ? (ticket.slack_thread_ts ?? undefined) : undefined;
  try {
    await app.client.chat.postMessage({ channel, thread_ts, text });
  } catch (err) {
    console.error("[slack] notify failed:", err instanceof Error ? err.message : err);
  }
}

// Resolve a Slack user id to a readable label: known team profile > Slack display name > generic.
const nameCache = new Map<string, string>();
async function userLabel(uid: string, botUserId?: string): Promise<string> {
  if (uid === botUserId) return "Rex (you)";
  const p = getPersonBySlackId(uid);
  if (p) return `${p.name} (${p.role})`;
  if (nameCache.has(uid)) return nameCache.get(uid)!;
  try {
    const r: any = await app!.client.users.info({ user: uid });
    const name = r.user?.profile?.real_name || r.user?.real_name || r.user?.name || "teammate";
    nameCache.set(uid, name);
    return name;
  } catch {
    return "teammate";
  }
}

// Build a live roster of this channel's members from their Slack profiles (name + job title),
// so Rex can answer "who's the designer" without manual setup. Needs channels:read/groups:read
// + users:read; degrades to "" if unavailable. Titles are user-set, so they're length-capped
// and newline-stripped before reaching the model.
const rosterCache = new Map<string, { text: string; ts: number }>();
async function channelRoster(channel: string, botUserId?: string): Promise<string> {
  if (!app) return "";
  const cached = rosterCache.get(channel);
  if (cached && Date.now() - cached.ts < 300_000) return cached.text; // 5-min cache
  try {
    const res: any = await app.client.conversations.members({ channel, limit: 50 });
    const lines: string[] = [];
    for (const id of (res.members ?? []).filter((m: string) => m !== botUserId)) {
      try {
        const info: any = await app.client.users.info({ user: id });
        if (info.user?.is_bot || info.user?.deleted) continue;
        const name = info.user?.profile?.real_name || info.user?.real_name || info.user?.name || "teammate";
        const title = (info.user?.profile?.title || "").replace(/[\n\r]+/g, " ").slice(0, 80);
        const p = getPersonBySlackId(id);
        lines.push(`- ${name}${title ? ` — ${title}` : ""}${p ? ` [talk to as ${p.role}]` : ""}`);
      } catch {
        /* skip member we can't resolve */
      }
    }
    const text = lines.join("\n");
    rosterCache.set(channel, { text, ts: Date.now() });
    return text;
  } catch {
    return "";
  }
}

// Only Slack workspace admins/owners may command destructive admin actions.
const adminCache = new Map<string, boolean>();
async function isWorkspaceAdmin(uid: string): Promise<boolean> {
  if (adminCache.has(uid)) return adminCache.get(uid)!;
  try {
    const r: any = await app!.client.users.info({ user: uid });
    const ok = !!(r.user?.is_admin || r.user?.is_owner || r.user?.is_primary_owner);
    adminCache.set(uid, ok);
    return ok;
  } catch {
    return false;
  }
}

// Resolve a job-title keyword (e.g. "developer") to the Slack user ids whose profile title matches.
async function usersByTitle(keyword: string, botUserId?: string): Promise<string[]> {
  if (!app || !keyword) return [];
  try {
    const res: any = await app.client.users.list({ limit: 500 });
    const k = keyword.toLowerCase();
    return (res.members ?? [])
      .filter((u: any) => !u.is_bot && !u.deleted && u.id !== botUserId && (u.profile?.title || "").toLowerCase().includes(k))
      .map((u: any) => u.id);
  } catch {
    return [];
  }
}

const uniq = (a: string[]) => [...new Set(a)];

// Channel admin actions: add/remove members, create/archive channels. Intent is extracted by the
// model (typo/phrasing tolerant), then executed deterministically — gated to workspace admins.
async function handleAdmin(
  args: { channel: string; threadTs: string; user: string; botUserId?: string; text: string; say: (m: any) => Promise<any> },
  text: string,
): Promise<boolean> {
  if (!app) return false;
  // Pre-filter: need an admin VERB *and* a channel/member context signal, so normal coding chat
  // ("add a divide function") doesn't trigger a second model call.
  const hasVerb = /\b(create|archive|delete|remove|kick|add|invite)\b/i.test(text);
  const hasContext =
    /\b(channel|group|members?|people|everyone|team|developers?|designers?|engineers?|qa|testers?|writers?|marketers?)\b/i.test(text) ||
    /<@[A-Z0-9]+>/.test(args.text);
  if (!hasVerb || !hasContext) return false;

  const intent = await parseAdminIntent(args.text);
  if (intent.action === "none") return false;

  if (!(await isWorkspaceAdmin(args.user))) {
    await args.say({ thread_ts: args.threadTs, text: ":lock: Only a workspace admin can ask me to add/remove people or manage channels." });
    return true;
  }

  const reply = (t: string) => args.say({ thread_ts: args.threadTs, text: t });
  try {
    if (intent.action === "create_channel") {
      const name = intent.name.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/\s+/g, "-").slice(0, 80);
      if (!name) {
        await reply("What should I name the channel? e.g. `create a channel called design-team`");
        return true;
      }
      const res: any = await app.client.conversations.create({ name, is_private: intent.private });
      const ch = res.channel.id;
      const ids = uniq([...intent.inviteUserIds, ...(intent.inviteRole ? await usersByTitle(intent.inviteRole, args.botUserId) : [])]).filter((id) => id !== args.botUserId);
      let added = 0;
      if (ids.length) {
        try {
          await app.client.conversations.invite({ channel: ch, users: ids.join(",") });
          added = ids.length;
        } catch {
          /* some may already be in / unresolvable */
        }
      }
      await reply(`:white_check_mark: Created <#${ch}|${res.channel.name}>${added ? ` and added ${added} ${intent.inviteRole || "member"}(s).` : "."}`);
    } else if (intent.action === "invite_users") {
      const ids = uniq([...intent.userIds, ...(intent.role ? await usersByTitle(intent.role, args.botUserId) : [])]).filter((id) => id !== args.botUserId);
      if (!ids.length) {
        await reply("Who should I add? @-mention them or give a role (e.g. \"add all developers\").");
        return true;
      }
      await app.client.conversations.invite({ channel: args.channel, users: ids.join(",") });
      await reply(`:white_check_mark: Added ${ids.map((i) => `<@${i}>`).join(", ")} to this channel.`);
    } else if (intent.action === "kick_users") {
      const ids = uniq([...intent.userIds, ...(intent.role ? await usersByTitle(intent.role, args.botUserId) : [])]).filter((id) => id !== args.botUserId);
      if (!ids.length) {
        await reply("Who should I remove? @-mention them.");
        return true;
      }
      const done: string[] = [];
      for (const id of ids) {
        try {
          await app.client.conversations.kick({ channel: args.channel, user: id });
          done.push(`<@${id}>`);
        } catch (e: any) {
          await reply(`:warning: Couldn't remove <@${id}>: \`${e?.data?.error || e}\``);
        }
      }
      if (done.length) await reply(`:white_check_mark: Removed ${done.join(", ")} from this channel.`);
    } else if (intent.action === "archive_channel") {
      const target = intent.channelId || args.channel;
      if (target === args.channel) await reply(":file_folder: Archiving this channel…");
      await app.client.conversations.archive({ channel: target });
      if (target !== args.channel) await reply(":white_check_mark: Archived that channel.");
    }
    console.log(`[admin] ${args.user} ${intent.action} in ${args.channel}`);
  } catch (e: any) {
    await reply(`:warning: Couldn't do that: \`${e?.data?.error || e?.message || e}\``);
  }
  return true;
}

// Pull the thread transcript so Rex can reply with full conversation context.
// Needs channels:history / groups:history scope; degrades to "" if unavailable.
async function threadContext(channel: string, threadTs: string, botUserId?: string): Promise<string> {
  if (!app) return "";
  try {
    const res: any = await app.client.conversations.replies({ channel, ts: threadTs, limit: 20 });
    const lines: string[] = [];
    for (const m of res.messages ?? []) {
      const uid = m.user || (m.bot_id ? botUserId : undefined);
      // Neutralise delimiter/markup injection at the source before it reaches the model.
      const text = stripMention(m.text || "")
        .trim()
        .replace(/-{2,}/g, "—")
        .replace(/<\/?conversation>/gi, "");
      if (!text) continue;
      lines.push(`${uid ? await userLabel(uid, botUserId) : "someone"}: ${text}`);
    }
    return lines.join("\n");
  } catch {
    return "";
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
    queued: true, // straight into the work queue for Rex
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
  botUserId?: string;
  say: (msg: any) => Promise<any>;
}): Promise<void> {
  const text = stripMention(args.text);
  if (!text) {
    await args.say({ thread_ts: args.threadTs, text: "Hey — I'm Rex. Tell me what to build or fix, or use `title :: description` to file work directly." });
    return;
  }

  // Research request → kick off a web-research job; reply with a link that fills in when ready.
  const rm = text.match(/^research[:\s]+(.+)/is);
  if (rm) {
    const topic = rm[1].trim();
    const id = startResearch(topic);
    await args.say({
      thread_ts: args.threadTs,
      text: `:mag: On it — researching *${topic.slice(0, 140)}*.\nReport (ready in a few minutes, lives 24h): ${config.publicUrl}/r/${id}`,
    });
    return;
  }

  // Acknowledge-then-deliver: a shared link/document or a "review / analyze / go through this"
  // request takes real work. Ack immediately, then read + think async, then post the real answer.
  const unwrapped = text.replace(/<(https?:\/\/[^|>]+)(\|[^>]*)?>/g, "$1");
  const hasUrl = /https?:\/\/\S+/i.test(unwrapped);
  const heavyIntent = /\b(review|analy[sz]e|go through|read (this|the|it)|look (at|into)|evaluate|assess|summari[sz]e|feedback on)\b/i.test(unwrapped);
  if ((hasUrl || heavyIntent) && !isTrivial(unwrapped)) {
    await args.say({ thread_ts: args.threadTs, text: ":eyes: On it — going through it now. I'll come back with my take in a moment." });
    const person = getPersonBySlackId(args.user);
    const profile = person ? { name: person.name, role: person.role, notes: person.notes } : undefined;
    const ctx = await threadContext(args.channel, args.threadTs, args.botUserId);
    consideredReply(unwrapped, profile, ctx)
      .then((reply) => args.say({ thread_ts: args.threadTs, text: reply }))
      .catch(() => args.say({ thread_ts: args.threadTs, text: "I hit a snag working through that — mind resending it?" }));
    return;
  }

  // Explicit ticket syntax (contains "::") goes straight to a ticket — no triage needed.
  if (text.includes("::")) {
    const { title, description } = toTicket(args.text);
    await fileTicket({ ...args, title, description });
    return;
  }

  const relayTargets = [...args.text.matchAll(/<@([A-Z0-9]+)>/g)]
    .map((m) => m[1])
    .filter((id) => id !== args.botUserId && id !== args.user);

  // Admin actions (add/remove members, create/archive channels) — gated to workspace admins.
  // Checked before relay so "remove @X" isn't treated as a message relay.
  if (await handleAdmin(args, text)) return;

  // Relay (deterministic): if the user @-mentions a real person (not Rex or themselves), treat
  // it as "deliver this message to them". Strip leading filler words to get the actual message.
  if (relayTargets.length) {
    let msg = text.trim();
    let prev: string;
    do {
      prev = msg;
      msg = msg.replace(/^\s*(please|tell|remind|notify|message|ping|ask|let|pass|on|to|that|them|him|her|everyone|the\s+team)\b[:,]?\s*/i, "");
    } while (msg !== prev);
    msg = msg.trim();
    const mentions = relayTargets.map((id) => `<@${id}>`).join(" ");
    if (!msg) {
      await args.say({ thread_ts: args.threadTs, text: `What should I tell ${mentions}?` });
      return;
    }
    await args.say({ thread_ts: args.threadTs, text: `${mentions} — :speech_balloon: from <@${args.user}>: ${msg}` });
    return;
  }

  // Otherwise let Rex decide: real work -> ticket, relay -> notify a person, conversation -> reply.
  // If we know who this is (team profile), pass their role so Rex adapts deterministically.
  const person = getPersonBySlackId(args.user);
  const profile = person ? { name: person.name, role: person.role, notes: person.notes } : undefined;
  // Greetings/short messages skip the expensive Slack fetches (thread history + member roster).
  const trivial = isTrivial(text);
  const context = trivial ? "" : await threadContext(args.channel, args.threadTs, args.botUserId);
  const members = trivial ? "" : await channelRoster(args.channel, args.botUserId);
  const decision = await triage(text, profile, context, members);

  if (decision.kind === "relay") {
    // Targets = everyone @-mentioned in the raw message except Rex and the sender.
    const targets = [...args.text.matchAll(/<@([A-Z0-9]+)>/g)]
      .map((m) => m[1])
      .filter((id) => id !== args.botUserId && id !== args.user);
    if (!targets.length) {
      await args.say({ thread_ts: args.threadTs, text: "Who should I tell? @-mention them and I'll pass it along." });
      return;
    }
    const mentions = targets.map((id) => `<@${id}>`).join(" ");
    await args.say({ thread_ts: args.threadTs, text: `${mentions} — :speech_balloon: from <@${args.user}>: ${decision.message}` });
    return;
  }

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
  app.event("app_mention", async ({ event, context, say }: any) => {
    const e = event as any;
    if (alreadyHandled(`${e.channel}:${e.ts}`)) return;
    await handleInbound({
      text: e.text ?? "",
      channel: e.channel,
      threadTs: e.thread_ts ?? e.ts,
      user: e.user ?? "unknown",
      botUserId: context?.botUserId,
      say,
    });
  });

  // Direct messages to Rex
  app.message(async ({ message, context, say }: any) => {
    const m = message as any;
    if (m.subtype || m.bot_id) return; // ignore bot/system messages
    if (m.channel_type !== "im") return; // only DMs here; channel use goes through app_mention
    if (alreadyHandled(`${m.channel}:${m.ts}`)) return;
    await handleInbound({
      text: m.text ?? "",
      channel: m.channel,
      threadTs: m.thread_ts ?? m.ts,
      user: m.user ?? "unknown",
      botUserId: context?.botUserId,
      say,
    });
  });

  await app.start();
  console.log("[slack] connected via Socket Mode");
}
