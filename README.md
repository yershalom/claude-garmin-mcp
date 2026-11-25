# Garmin MCP for Claude

Talk to your own Garmin data in Claude: *"How did I sleep this week?"*, *"Did my walks hit my
heart-rate target?"*, *"Show the sets I logged at the gym yesterday."*

A small, private [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that uses
Garmin's official, read-only [Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/).
It costs nothing to run for one person.

📖 **Full write-up:** [Talk to your Garmin data in Claude, for free](https://blog.yershalom.com/posts/garmin-mcp-claude/) (also on [dev.to](https://dev.to/yershalom/talk-to-your-garmin-data-in-claude-for-free-1928))

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yershalom/claude-garmin-mcp)

## How it works

```
Claude ──OAuth (GitHub sign-in, only you)──▶ Worker /mcp ──Bearer token──▶ Garmin Personal API
                                              │
                                              └─ KV: OAuth grants + cached Garmin token
```

- Your Garmin **personal API key** is a Worker secret. The Worker swaps it for a 24-hour access
  token, caches it in KV, and refreshes it an hour before it expires.
- **`/mcp` is locked.** Claude has to sign in through OAuth, which sends you to GitHub, and only the
  GitHub account in `ALLOWED_GITHUB_LOGIN` gets through. If it isn't set, nobody does.
- **Read-only.** Every tool is a `GET`. Names, profile photos and GPS coordinates are stripped from
  responses before they reach Claude.

## What it costs

| Piece | Cost |
|---|---|
| Garmin Connect Personal API | Free |
| Cloudflare Workers, Free plan (100,000 requests/day) | Free |
| Workers KV, Free plan (100,000 reads, 1,000 writes/day) | Free. This server writes about once a day |
| GitHub OAuth app | Free |
| Claude | Works on the Free plan, which allows one custom connector |
| Custom domain | Optional, about $10/year. The free `*.workers.dev` address works fine |
| **Total** | **$0** |

## Tools

| Tool | Data |
|---|---|
| `get_daily_summaries` | Steps, calories, intensity minutes, resting HR, stress, Body Battery per day |
| `get_daily_steps`, `get_daily_stress`, `get_hydration` | Per-day stats |
| `get_sleep_summaries`, `get_sleep_detail` | Sleep per night, or one night in detail |
| `get_daily_heart_rate`, `get_hrv_summaries`, `get_spo2` | Heart rate, HRV, blood oxygen |
| `get_body_battery`, `get_vo2_max`, `get_fitness_age` | Recovery and fitness |
| `get_weight` | Weight and body composition |
| `search_activities`, `get_activity`, `get_activity_workouts`, `list_activity_types` | Workouts, including strength sets and reps |
| `get_heart_rate_zones`, `get_profile_settings` | Settings |

Date-range tools accept up to a year. Garmin's API only allows 28 days per request, so the server
splits longer ranges into 28-day requests and merges the results.

## Set it up (about 15 minutes, all in the browser)

### 1. Garmin API key
Open the [Personal API Key page](https://connect.garmin.com/app/settings/personalApiToken) in Garmin Connect (sign in on the web if asked) →
**Create Key** → accept the terms → pick an expiry → **Create**. Copy the key: it's shown once.
Garmin's own guide: [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/).

### 2. Deploy
Click **Deploy to Cloudflare** above. It forks this repo into your GitHub, creates the KV
namespace and deploys the Worker. You don't need to edit any files.

Prefer doing it by hand? Fork the repo, then in Cloudflare go to **Workers & Pages → Create →
Import a repository**, pick your fork, and set the deploy command to `npx wrangler deploy`.

### 3. Find your Worker's address
Open the Worker's address, for example `https://garmin-mcp.<your-subdomain>.workers.dev`
(Cloudflare shows it on the Worker's page). The page lists the exact callback URL and connector
URL to copy in the next steps, and which secrets are still missing.

### 4. GitHub OAuth app
GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
- Homepage URL: your Worker address
- Authorization callback URL: the callback URL shown on your Worker's page (its address + `/callback`)
- Leave wildcard matching and device flow off

Copy the **Client ID**, and generate a **Client secret**.

### 5. Secrets
Cloudflare → your Worker → **Settings → Variables and Secrets → Add**, type **Secret**:

| Name | Value |
|---|---|
| `ALLOWED_GITHUB_LOGIN` | your GitHub username. Only this account can sign in |
| `GARMIN_API_KEY` | from step 1 |
| `GITHUB_CLIENT_ID` | from step 4 |
| `GITHUB_CLIENT_SECRET` | from step 4 |

### 6. Connect Claude
[claude.ai/customize/connectors](https://claude.ai/customize/connectors) → **Add custom
connector** → URL: the connector URL shown on your Worker's page (its address + `/mcp`) → **Connect** → approve → sign in with GitHub.

Start a new chat and ask: *"Summarise my last 7 days from Garmin."*

### Check it's locked
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://YOUR-WORKER/mcp   # must print 401
```

## Optional: the coach skill

[`skills/garmin-health-coach/SKILL.md`](skills/garmin-health-coach/SKILL.md) teaches the agent *how* to
use these tools: which ones answer which question, how to read recovery signals together, and how to
answer like a coach rather than dumping JSON. It's free, like everything else here.

- **claude.ai:** download [`dist/garmin-health-coach-plugin.zip`](dist/garmin-health-coach-plugin.zip)
  (click **Download raw file**), then Settings → Plugins → **Add → Upload plugin** and pick the zip.
- **Claude Code:** add this repo as a plugin marketplace and install it:
  ```
  /plugin marketplace add yershalom/claude-garmin-mcp
  /plugin install garmin-health-coach@claude-garmin-mcp
  ```
  Or copy `skills/garmin-health-coach` into `~/.claude/skills/`.
- **Other agents** that read `SKILL.md` files: put the folder wherever that agent loads skills from.

Then try: *"Should I train hard today?"* or *"Compare this week's sleep with last week's."*

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars      # fill in your key, a local GitHub OAuth app, your username
npm run check-garmin                # tests your Garmin key directly, no server needed
npm run dev                         # http://localhost:8787
```

For the local GitHub OAuth app, use the callback `http://localhost:8787/callback`. To try the tools,
run `npx @modelcontextprotocol/inspector` and connect to `http://localhost:8787/mcp`.
Claude itself can't reach `localhost`, so deploy before connecting Claude.

`npm run typecheck` checks the TypeScript.

## Updating from an older copy

Older versions had `ALLOWED_GITHUB_LOGIN` and `PUBLIC_URL` in `wrangler.jsonc`. After you update,
add `ALLOWED_GITHUB_LOGIN` as a secret (step 5). Until you do, sign-in is refused. `PUBLIC_URL` is
no longer needed; you can still set it under `vars` in `wrangler.jsonc` to pin one address if your
Worker has a custom domain as well as `workers.dev`.

## Security notes

- Secrets live only in Cloudflare (or your git-ignored `.dev.vars`). None are in the repo.
- To cut off access, remove the connector in Claude, delete the key in Garmin Connect, or both.
- The Garmin key expires on the date you picked. Make a new one and update `GARMIN_API_KEY`. The
  cached token is tied to the key, so it refreshes by itself.
- The Personal API is for your own data. Each person runs their own copy with their own key.

## Credits

Endpoint list and auth flow from Garmin's official
[connect-personal-api-python](https://github.com/garmin/connect-personal-api-python) client.
Built with [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) and the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

MIT licensed.
