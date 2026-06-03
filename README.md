# Rex — Autonomous Senior Engineer Platform

Rex is an AI engineer you assign tickets to. He works them autonomously using the
Claude Agent SDK, posts progress, and logs token burn + cost per ticket. Talk to him
in Slack or drive him from the dashboard.

```
Slack (Socket Mode) ─┐
                     ├─► Rex (one Node/TS service) ──► Claude Agent SDK + sub-agents
Dashboard (web) ─────┘            │
                          SQLite (rex.db): tickets · runs · events
```

Single service, single process, SQLite. No cloud, no queue, no build step. Lean by design.

## Setup

1. **Install** (already done if you see `node_modules/`):
   ```bash
   npm install
   ```

2. **Configure** — copy the example and fill it in:
   ```bash
   cp .env.example .env
   ```
   - `ANTHROPIC_API_KEY` — required. Rex runs on this.
   - `REX_WORKSPACE` — absolute path to the **one codebase** Rex works on.
   - Slack vars — optional. Omit them and the dashboard + worker still run.

3. **Run**:
   ```bash
   npm run dev      # watch mode
   # or
   npm start
   ```
   Dashboard: http://localhost:4000

## Using it

**Dashboard** — create a ticket, check "Queue for Rex immediately," and watch the live
activity log. The top strip shows total token burn (input/output/cache), run count, and
cumulative cost in USD. Per-run token + cost breakdown shows in the ticket detail.

**Slack** — `@Rex <title> :: <description>` in a channel, or DM him. The ticket is filed,
queued, and Rex posts progress + final result (with token/cost) back in the thread.

## How autonomy works

Rex runs with `permissionMode: bypassPermissions` — no approval prompts — but with
guardrails: he **cannot** `git push`, `rm -rf`, or `git reset --hard`. He fans work out
to two sub-agents when useful: `explorer` (read-only mapping) and `reviewer` (adversarial
check after changes). Cap of `REX_MAX_TURNS` agentic turns per ticket.

## Slack app setup (Socket Mode — no public URL)

1. https://api.slack.com/apps → **Create New App** → From scratch.
2. **Socket Mode** → enable. Generate an **app-level token** with `connections:write` → `SLACK_APP_TOKEN` (`xapp-`).
3. **OAuth & Permissions** → Bot Token Scopes: `app_mentions:read`, `chat:write`, `im:read`, `im:history`, `im:write`. Install to workspace → **Bot User OAuth Token** → `SLACK_BOT_TOKEN` (`xoxb-`).
4. **Event Subscriptions** → subscribe to bot events: `app_mention`, `message.im`.
5. **Basic Information** → **Signing Secret** → `SLACK_SIGNING_SECRET`.
6. Invite Rex to a channel: `/invite @Rex`.

## Data

Everything lives in `rex.db` (SQLite, gitignored). Delete it to reset state.

## Known tech debt (deliberate, lean-first)

- Dashboard has **no auth** — fine for localhost, not for a shared/deployed host.
- Tailwind via CDN (no build) — swap for a real build before deploying.
- **One ticket at a time** (single worker). Add concurrency when throughput demands it.
- Local-only persistence (SQLite). Move to Postgres when multi-instance is needed.
