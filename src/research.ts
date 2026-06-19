import { query } from "@anthropic-ai/claude-agent-sdk";
import { createArtifact, setArtifact } from "./artifacts.ts";
import { webCanUseTool } from "./rex.ts";

const RESEARCH_SYSTEM = `You are Rex, a sharp, skeptical research analyst. Research the user's topic
THOROUGHLY using web search and by fetching real sources.

Method (this is what makes the report trustworthy):
- Be EFFICIENT: do about 4–6 targeted web searches total, open a few key sources — then STOP
  searching and write. Do not over-search; you have a limited number of steps.
- Use multiple angles and don't rely on a single source; cross-check key facts. If sources
  disagree, say so.
- Be concrete: real numbers, names, dates. No vague filler. No invented facts — if you can't
  verify something, say it's uncertain.

Then write a comprehensive report in clean MARKDOWN with:
1. A short **Executive summary** at the top, in plain language anyone can read.
2. Well-structured sections with ## headings.
3. The substance — findings, data, comparisons, a balanced view.
4. **Rex's take** — your own analysis and a clear, opinionated recommendation at the end.
5. A **Sources** section listing the actual URLs you used.

Output ONLY the markdown report — no preamble.`;

/** Run a web research job and return the report as markdown. */
export async function runResearch(topic: string): Promise<string> {
  let out = "";
  for await (const m of query({
    prompt: `Research this topic and produce the report:\n\n${topic}`,
    options: {
      model: "sonnet",
      systemPrompt: RESEARCH_SYSTEM,
      allowedTools: ["WebSearch", "WebFetch"],
      maxTurns: 12,
      canUseTool: webCanUseTool,
    },
  })) {
    if (m.type === "result") out = ((m as any).result ?? "").trim();
  }
  if (!out) throw new Error("empty research result");
  return out;
}

function deriveTitle(md: string, fallback: string): string {
  const h = md.match(/^#{1,2}\s+(.+)$/m);
  return (h ? h[1] : fallback).replace(/[#*`]/g, "").trim().slice(0, 120) || "Research report";
}

/** Create a pending artifact, run the research async (bounded by a timeout), fill it when done. */
export function startResearch(topic: string): string {
  const id = createArtifact({ kind: "research", title: topic.slice(0, 120), query: topic });
  const timeout = new Promise<string>((_, rej) => setTimeout(() => rej(new Error("research timed out (6 min)")), 6 * 60_000));
  Promise.race([runResearch(topic), timeout])
    .then((md) => setArtifact(id, { status: "ready", content_md: md, title: deriveTitle(md, topic) }))
    .catch((e) => setArtifact(id, { status: "error", content_md: `Research failed: ${e instanceof Error ? e.message : String(e)}` }));
  return id;
}
