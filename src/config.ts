import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (copy .env.example to .env and fill it in)`);
  return v;
}

// Auth, in priority order:
//  1. CLAUDE_CODE_OAUTH_TOKEN — subscription token (free with Max/Pro)
//  2. ANTHROPIC_API_KEY — paid API credits
//  3. stored Claude Code login — the SDK reuses the same credentials as the `claude` CLI
// If none of the env vars are set we fall back to the machine's CLI login.
const authMode = process.env.CLAUDE_CODE_OAUTH_TOKEN
  ? "subscription"
  : process.env.ANTHROPIC_API_KEY
    ? "api-key"
    : "cli-login";

export const config = {
  authMode,
  workspace: required("REX_WORKSPACE"),
  model: process.env.REX_MODEL || "opus",
  maxTurns: Number(process.env.REX_MAX_TURNS || 40),
  port: Number(process.env.PORT || 4000),
  // Bind localhost-only by default — safe on a public server (reach it via SSH tunnel
  // or a reverse proxy). Set HOST=0.0.0.0 only if you intentionally expose it.
  host: process.env.HOST || "127.0.0.1",
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || "",
    appToken: process.env.SLACK_APP_TOKEN || "",
    signingSecret: process.env.SLACK_SIGNING_SECRET || "",
    enabled: Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && process.env.SLACK_SIGNING_SECRET),
  },
};

export type Config = typeof config;
