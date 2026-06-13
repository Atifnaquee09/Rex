import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// QMD (Quick Markdown Search) stores Rex's long-term memory as markdown files in
// /home/rex/memory and indexes them. We use the BM25 `search` path — instant, no model
// load — which is the safe choice on this shared 4 GB box (the reranker is too heavy).
const QMD = "/opt/node24/bin/qmd";
const NODE24_BIN = "/opt/node24/bin";
const MEMORY_DIR = "/home/rex/memory";

export const memoryEnabled = existsSync(QMD);

const ANSI = new RegExp("\\u001b\\[[0-9;]*m", "g");
const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Recall relevant memory for a query via QMD keyword search. Returns cleaned text, or "" on miss/error. */
export function recallMemory(query: string): Promise<string> {
  if (!memoryEnabled) return Promise.resolve("");
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const child = spawn(QMD, ["search", query], {
      env: { ...process.env, PATH: `${NODE24_BIN}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "/home/rex" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("");
    }, 8000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(stripAnsi(out).trim().slice(0, 1800));
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
  });
}

export { MEMORY_DIR };
