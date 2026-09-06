# FutPicks MCP Server

Model Context Protocol server for football data: **probable lineups with a per-player start
probability and expected fantasy points**, match analysis, model picks and a public track record —
LaLiga, Premier League, Serie A, Bundesliga, Ligue 1 and Primeira Liga.

Every tool calls the public [futpicks.com](https://futpicks.com) REST API over HTTPS. No database
access, no shell, no local secrets beyond the API tokens you put in the environment. **The lineup,
match and track-record tools need no key at all.**

The lineups are graded in public against the confirmed XI, so the accuracy the tools report is
measured, not claimed. Same data as
[futpicks.com/onces/la-liga](https://futpicks.com/onces/la-liga).

## Quick start

Add it to any MCP client (Claude Code shown here) — no install step, `npx` fetches it:

```json
{
  "mcpServers": {
    "futpicks": {
      "command": "npx",
      "args": ["-y", "futpicks-mcp"]
    }
  }
}
```

Then ask for a probable lineup: `flab_teams` to find a club, `flab_matches_upcoming` for the
fixtures, `flab_match_details` for the projected XI and the model's read of the match.

To unlock the Pro and admin tools, add the keys:

```json
{
  "mcpServers": {
    "futpicks": {
      "command": "npx",
      "args": ["-y", "futpicks-mcp"],
      "env": {
        "FUTPICKS_API_KEY": "flab_live_…"
      }
    }
  }
}
```

## Building from source

```bash
git clone https://github.com/Khavel/futpicks-mcp.git
cd futpicks-mcp
npm install
npm run build      # compiles src/index.ts → dist/index.js
```

For local development with hot reload: `npm run dev`.

## Environment variables

| Variable | Required for | Description |
|----------|--------------|-------------|
| `FUTPICKS_API_URL` | No | API base URL (default: `https://futpicks.com`) |
| `FUTPICKS_API_KEY` | Data tools | Data-scope API key (ProTier policy) |
| `FUTPICKS_OPS_TOKEN` | Ops tools | Ops-scope API key (Admin policy, admin only) |

Public tools work with no token at all.

### Where to get the tokens

Mint API keys from the web app: **futpicks.com → Account → API Keys** (Cuenta → Claves de API).

- `FUTPICKS_API_KEY` — create a **Data**-scope key. It looks like `flab_live_…` and satisfies the
  Pro-tier (ProTier) endpoints. Pro and admin users can mint these.
- `FUTPICKS_OPS_TOKEN` — create an **Ops**-scope key. It looks like `flab_ops_…` and satisfies the
  admin (Ops) endpoints. Only admins can mint these.

The raw key is shown **once** at creation, so copy it into your environment immediately. Keys are
stored only as SHA-256 hashes, support optional expiry, and can be revoked from the same screen;
revoked or expired keys are rejected with `401`.

## Tools

### Public (no auth)

| Tool | Endpoint | Key params |
|------|----------|------------|
| `flab_picks_today` | `GET /api/picks/today` | `date?`, `rating?`, `market?` |
| `flab_pick_details` | `GET /api/picks/{id}` | `id` |
| `flab_picks_board` | `GET /api/picks/board` | `date?`, `league?`, `market?`, `rating?`, odds/edge ranges |
| `flab_matches_today` | `GET /api/matches/today` | — |
| `flab_match_details` | `GET /api/matches/{id}[/intelligence]` | `id`, `includeIntelligence?` |
| `flab_matches_upcoming` | `GET /api/matches/upcoming` | `days?` (1–30) |
| `flab_teams` | `GET /api/teams` | — |
| `flab_track_record` | `GET /api/track-record/filtered` | `market?`, `league?`, `rating?`, `outcome?`, `from?`, `to?` |
| `flab_health` | `GET /api/health` | — |

### Data tools (require `FUTPICKS_API_KEY`)

| Tool | Endpoint | Key params |
|------|----------|------------|
| `flab_picks_history` | `GET /api/picks/history` | `from?`, `to?`, `league?`, `market?`, `rating?`, `page?`, `pageSize?` |
| `flab_evaluate_matches` | `GET /api/evaluate/matches` | — |
| `flab_evaluate_match` | `GET /api/evaluate/{matchId}` | `matchId` |
| `flab_backtest_run` | `POST /api/backtest/run` | `dateFrom`, `dateTo`, `rating?`, `market?`, `minEdge?`, `leagueId?` |
| `flab_export_picks` | `GET /api/picks/export` | `from?`, `to?`, `market?`, `rating?` (returns CSV) |
| `flab_data_catalog` | `GET /api/v1/data` | — |

### Ops tools (require `FUTPICKS_OPS_TOKEN`, admin-only)

| Tool | Endpoint | Key params |
|------|----------|------------|
| `flab_ops_run` | `POST /api/v1/ops/operations/{kind}` | `kind`, plus `date?`/`lastDays?`/`windowDays?`/`matchId?` |
| `flab_ops_status` | `GET /api/v1/ops/operations/{id}[/result]` | `id`, `includeResult?` |

`flab_ops_run` kinds: `ingestion-runs`, `scoring-runs`, `settlement-runs`, `calibration-runs`,
`intelligence-refreshes`. The server auto-generates an `Idempotency-Key` per ops POST.

## Claude Desktop configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "footballlab": {
      "command": "node",
      "args": ["C:/Users/ceja_/Desktop/Desarrollos/Furbov2/mcp-server/dist/index.js"],
      "env": {
        "FUTPICKS_API_URL": "https://futpicks.com",
        "FUTPICKS_API_KEY": "your-pro-tier-token",
        "FUTPICKS_OPS_TOKEN": "your-admin-token"
      }
    }
  }
}
```

## Verify locally

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Then call `flab_health` (no token needed) — it should return live system status.

## Security

- No tool reads DB connection strings, appsettings secrets, or shells into the VPS.
- All inputs are validated with zod; page sizes and ranges are capped server-side.
- Tokens are read from environment variables only and never logged.
- Data/ops tools fail with a clear message when their token is missing — they never fall back to an
  unauthenticated call.
- Ops mutations send a fresh `Idempotency-Key` so retries are deduplicated by the API.
