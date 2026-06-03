import { query, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.ts";
import { getSetting } from "./db.ts";
import type { Ticket, EventType, PersonRole } from "./types.ts";

export interface RunOutcome {
  ok: boolean;
  summary: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  num_turns: number;
}

export type EventSink = (type: EventType, content: string) => void;

const REX_PERSONA = `You are Rex, an autonomous Senior Software Engineer employee.
You own your technical domain: make confident decisions, defend them, and deliver results.
Principles:
- Start lean. Build the minimum that solves the problem well. Complexity must earn its place.
- Read existing code before changing it. Match the surrounding style.
- No speculative work, no future-proofing that wasn't asked for.
- Security first: never introduce injection, XSS, or OWASP top-10 issues.
You are working a ticket end to end. When done, end your final message with a concise
"## Result" summary: what you changed, files touched, and how it was verified.
If you cannot complete it, end with "## Blocked" and the exact reason.`;

// Specialist sub-agents Rex can fan work out to.
const SUBAGENTS: Record<string, AgentDefinition> = {
  explorer: {
    description: "Read-only codebase explorer. Use to locate code, trace callers/dependencies, and map structure before changing anything.",
    prompt: "You are a code explorer. Search broadly, read excerpts, and report precise findings (file paths + line numbers). Do not modify files.",
    tools: ["Read", "Grep", "Glob"],
    model: "sonnet",
  },
  reviewer: {
    description: "Adversarial code reviewer. Use after making changes to catch bugs, security issues, and regressions.",
    prompt: "You are an adversarial reviewer. Stress-test the change: correctness, edge cases, security, and adjacent breakage. Report concrete issues with file:line. Do not modify files.",
    tools: ["Read", "Grep", "Glob"],
    model: config.model,
  },
};

export type Triage =
  | { kind: "task"; title: string; description: string }
  | { kind: "chat"; reply: string }
  | { kind: "relay"; message: string };

const ROUTING_RULES = `Decide whether the message is a request to do actual software work (something
you'd file as a ticket and execute in a codebase) or just conversation.

Reply in EXACTLY one of these formats, nothing else:
TASK :: <short imperative title> :: <one-line description of the work>
RELAY :: <the message to pass along, phrased as a clear heads-up>
CHAT :: <your reply>

- "add/fix/build/refactor/implement <something in code>" is TASK.
- RELAY only when the user explicitly asks you to tell / notify / remind / message / ping
  another person (e.g. "tell @Sara that…", "remind the team to…"). Write the note to deliver.
- Greetings, small talk, status/role questions, and "what can you do" are CHAT.
When you reply CHAT, keep it short (1–4 sentences) unless real detail is genuinely needed.`;

const AUDIENCE_GUIDE = `Adapt every CHAT reply to your audience:
- Business / non-technical (outcomes, timelines, cost, status, no jargon): plain business
  language, lead with the bottom line, no technical detail unless they ask.
- Technical (code, architecture, tools, errors, jargon): match them with precise technical depth.`;

export interface SpeakerProfile {
  name: string;
  role: PersonRole;
  notes?: string;
}

/** Classify a Slack message as work-to-do or conversation, in Rex's configured voice. */
export async function triage(message: string, profile?: SpeakerProfile, context?: string): Promise<Triage> {
  const persona = getSetting("persona", "You are Rex, the CTO — a senior engineering leader.");
  const profileLine = profile
    ? `The person who just wrote is ${profile.name}, whose role is "${profile.role}".${profile.notes ? " Notes: " + profile.notes : ""} Tailor your reply to them specifically.`
    : "Infer the audience (business vs technical) from how they write.";
  const contextBlock = context
    ? `\n\n--- Conversation so far (oldest first; the last line is what you're replying to) ---\n${context}\n--- end conversation ---\nUse this context. Do not ask about things it already makes clear.`
    : "";
  const system = `${persona}\n\n${ROUTING_RULES}\n\n${AUDIENCE_GUIDE}\n\n${profileLine}${contextBlock}`;
  let out = "";
  try {
    for await (const m of query({
      prompt: message,
      options: { model: "sonnet", systemPrompt: system, allowedTools: [], maxTurns: 1 },
    })) {
      if (m.type === "result") out = ((m as any).result ?? "").trim();
    }
  } catch {
    return { kind: "chat", reply: "I hit a snag reading that. Try again, or file work with `title :: description`." };
  }
  if (/^TASK\s*::/i.test(out)) {
    const parts = out.split("::").map((s) => s.trim());
    return { kind: "task", title: parts[1] || message.slice(0, 80), description: parts[2] || "" };
  }
  if (/^RELAY\s*::/i.test(out)) {
    return { kind: "relay", message: out.replace(/^RELAY\s*::\s*/i, "").trim() || message };
  }
  const reply = out.replace(/^CHAT\s*::\s*/i, "").trim();
  return { kind: "chat", reply: reply || "Hey — I'm Rex. Tell me what to build or fix and I'll take it from there." };
}

export async function runTicket(ticket: Ticket, runId: number, sink: EventSink): Promise<RunOutcome> {
  const prompt = `# Ticket #${ticket.id}: ${ticket.title}

${ticket.description || "(no description provided)"}

Work this ticket to completion in the current repository.`;

  const outcome: RunOutcome = {
    ok: false,
    summary: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
    num_turns: 0,
  };

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: config.workspace,
        model: config.model,
        maxTurns: config.maxTurns,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Autonomy with guardrails: Rex can do its job, but cannot push or nuke the repo.
        disallowedTools: ["Bash(git push:*)", "Bash(rm -rf:*)", "Bash(git reset --hard:*)"],
        agents: SUBAGENTS,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `${REX_PERSONA}\n\n## Team standards & project knowledge\n${getSetting("standards", "")}`,
        },
      },
    })) {
      switch (message.type) {
        case "assistant": {
          const content = (message as any).message?.content ?? [];
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              sink("assistant", block.text.trim());
            } else if (block.type === "tool_use") {
              const input = JSON.stringify(block.input ?? {});
              sink("tool", `${block.name} ${input.length > 300 ? input.slice(0, 300) + "…" : input}`);
            }
          }
          break;
        }
        case "result": {
          const m = message as any;
          const u = m.usage ?? {};
          outcome.input_tokens = u.input_tokens ?? 0;
          outcome.output_tokens = u.output_tokens ?? 0;
          outcome.cache_read_tokens = u.cache_read_input_tokens ?? 0;
          outcome.cache_creation_tokens = u.cache_creation_input_tokens ?? 0;
          outcome.cost_usd = m.total_cost_usd ?? 0;
          outcome.num_turns = m.num_turns ?? 0;
          outcome.summary = m.subtype === "success" ? (m.result ?? "") : `Error: ${m.subtype}`;
          outcome.ok = m.subtype === "success" && !m.is_error;
          sink("result", outcome.summary || `(run ended: ${m.subtype})`);
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    outcome.ok = false;
    outcome.summary = `Run crashed: ${err instanceof Error ? err.message : String(err)}`;
    sink("error", outcome.summary);
  }

  return outcome;
}
