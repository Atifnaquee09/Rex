import { spawn } from "node:child_process";
import { config } from "./config.ts";

const TIMEOUT_MS = 60_000; // hard kill after 60s
const MAX_OUTPUT = 100 * 1024; // 100KB cap per stream

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

/**
 * Run a shell script body with bash -c. Executes as the OS user the Rex process
 * runs as (non-root `rex` in production) in the configured workspace. Output is
 * capped and the process is hard-killed after TIMEOUT_MS.
 */
export function runScript(body: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn("bash", ["-c", body], {
      cwd: config.workspace,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? "C.UTF-8" },
    });

    let stdout = "";
    let stderr = "";
    let timed_out = false;

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout = (stdout + d.toString()).slice(0, MAX_OUTPUT);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr = (stderr + d.toString()).slice(0, MAX_OUTPUT);
    });

    const timer = setTimeout(() => {
      timed_out = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: code ?? -1,
        stdout: timed_out ? stdout + "\n[killed: exceeded 60s timeout]" : stdout,
        stderr,
        duration_ms: Date.now() - start,
        timed_out,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exit_code: -1,
        stdout,
        stderr: stderr + "\n[spawn error] " + String(err),
        duration_ms: Date.now() - start,
        timed_out,
      });
    });
  });
}
