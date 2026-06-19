import { query } from "@anthropic-ai/claude-agent-sdk";
import { createArtifact, setArtifact } from "./artifacts.ts";

const RESEARCH_SYSTEM = `You are Rex, a sharp, skeptical research analyst. Research the user's topic
THOROUGHLY using web search and by fetching real sources.

Method (this is what makes the report trustworthy):
- Search from multiple angles; open and read several real sources — do not rely on one.
- Cross-check key facts/figures across sources. If sources disagree, say so.
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
      maxTurns: 40,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
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

/** Create a pending artifact, run the research async, fill it when done. Returns the artifact id. */
export function startResearch(topic: string): string {
  const id = createArtifact({ kind: "research", title: topic.slice(0, 120), query: topic });
  runResearch(topic)
    .then((md) => setArtifact(id, { status: "ready", content_md: md, title: deriveTitle(md, topic) }))
    .catch((e) => setArtifact(id, { status: "error", content_md: `Research failed: ${e instanceof Error ? e.message : String(e)}` }));
  return id;
}
