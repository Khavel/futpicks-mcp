#!/usr/bin/env node
/**
 * FutPicks MCP Server
 *
 * Agent-friendly access to FutPicks (futpicks.com): probable lineups, picks, matches,
 * track record, backtests, on-demand evaluation, and pipeline operations.
 *
 * All tools call HTTP endpoints — no direct database, SSH, or local secret
 * access beyond API tokens read from the environment.
 *
 * Auth tiers (FutPicks uses one JWT scheme with ProTier / Admin policies):
 *   - "none" : public endpoints, no token
 *   - "data" : ProTier endpoints, Bearer FUTPICKS_API_KEY
 *   - "ops"  : Admin endpoints,   Bearer FUTPICKS_OPS_TOKEN
 *
 * Environment variables:
 *   FUTPICKS_API_URL   - API base (default: https://futpicks.com)
 *   FUTPICKS_API_KEY   - Pro-tier bearer token (data tools)
 *   FUTPICKS_OPS_TOKEN - Admin bearer token (ops tools)
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE = (process.env.FUTPICKS_API_URL ?? "https://futpicks.com").replace(/\/+$/, "");
const API_KEY = process.env.FUTPICKS_API_KEY ?? "";
const OPS_TOKEN = process.env.FUTPICKS_OPS_TOKEN ?? "";
const CHARACTER_LIMIT = 40_000;

// ── HTTP client ───────────────────────────────────────────────────────────

type AuthTier = "none" | "data" | "ops";

interface FetchOptions {
  method?: "GET" | "POST";
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  auth?: AuthTier;
}

function tokenFor(auth: AuthTier): { token?: string; missing?: string } {
  if (auth === "data") {
    return API_KEY ? { token: API_KEY } : { missing: "FUTPICKS_API_KEY (Pro-tier token)" };
  }
  if (auth === "ops") {
    return OPS_TOKEN ? { token: OPS_TOKEN } : { missing: "FUTPICKS_OPS_TOKEN (admin token)" };
  }
  return {};
}

async function api<T = unknown>(path: string, opts: FetchOptions = {}): Promise<T> {
  const { method = "GET", params, body, auth = "none" } = opts;

  const { token, missing } = tokenFor(auth);
  if (missing) {
    throw new Error(`${missing} is not configured. Set it to call this tool.`);
  }

  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json, text/csv;q=0.9, */*;q=0.5",
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Ops mutations require an Idempotency-Key — mint one so agent retries are safe.
  if (auth === "ops" && method === "POST") headers["Idempotency-Key"] = randomUUID();

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`API ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json") || ct.includes("application/problem+json")) {
    return (text ? JSON.parse(text) : null) as T;
  }
  // CSV exports and other text payloads pass through raw.
  return text as unknown as T;
}

function truncate(s: string): string {
  if (s.length <= CHARACTER_LIMIT) return s;
  return s.slice(0, CHARACTER_LIMIT) + "\n\n... [TRUNCATED — narrow the date range or filters to reduce data]";
}

function ok(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: truncate(text) }] };
}

function err(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// ── Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "futpicks-mcp",
  version: "1.0.0",
});

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TOOLS (no auth)
// ════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "flab_picks_today",
  {
    title: "Get Today's Picks",
    description:
      "Get FutPicks' published picks for a date (defaults to today UTC). Public board shows Good-rated picks by default. " +
      "Markets: H2H, OU2.5, BTTS, AsianHandicap, DoubleChance, etc. Public — no auth.",
    inputSchema: {
      date: z.string().optional().describe("Date YYYY-MM-DD (default: today UTC)"),
      rating: z.enum(["Good", "Marginal", "Weak"]).optional().describe("Filter by rating (default: Good)"),
      market: z.string().optional().describe("Filter by market, e.g. H2H, OU2.5, BTTS"),
    },
    annotations: READ,
  },
  async (p) => {
    try {
      return ok(await api("/api/picks/today", { params: { date: p.date, rating: p.rating, market: p.market } }));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_pick_details",
  {
    title: "Get Pick Details",
    description:
      "Get full detail for a single pick by ID: market, line, edge, score, rating, and the scoring-block breakdown. Public — no auth.",
    inputSchema: { id: z.number().int().positive().describe("Pick ID") },
    annotations: READ,
  },
  async (p) => {
    try { return ok(await api(`/api/picks/${p.id}`)); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_picks_board",
  {
    title: "Get Picks Board",
    description:
      "Full picks board for a date with rich filters: edge/odds/data-quality ranges, lineup-confirmed flag, and preview inclusion. Public — no auth.",
    inputSchema: {
      date: z.string().optional().describe("Date YYYY-MM-DD (default: today UTC)"),
      league: z.string().optional().describe("Filter by league name"),
      market: z.string().optional().describe("Filter by market"),
      rating: z.enum(["Good", "Marginal", "Weak"]).optional().describe("Filter by rating"),
      minOdds: z.number().optional().describe("Minimum decimal odds"),
      maxOdds: z.number().optional().describe("Maximum decimal odds"),
      minEdge: z.number().optional().describe("Minimum edge (e.g. 0.02)"),
      maxEdge: z.number().optional().describe("Maximum edge"),
      includePreview: z.boolean().optional().describe("Include T-3h preview picks (default: true)"),
    },
    annotations: READ,
  },
  async (p) => {
    try {
      return ok(await api("/api/picks/board", {
        params: {
          date: p.date, league: p.league, market: p.market, rating: p.rating,
          minOdds: p.minOdds, maxOdds: p.maxOdds, minEdge: p.minEdge, maxEdge: p.maxEdge,
          includePreview: p.includePreview,
        },
      }));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_matches_today",
  {
    title: "Get Today's Matches",
    description: "Get today's matches with teams, league, kickoff, line snapshots, and any picks. Public — no auth.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try { return ok(await api("/api/matches/today")); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_match_details",
  {
    title: "Get Match Details",
    description:
      "Get a single match by ID. Set includeIntelligence=true to also fetch the sports-intelligence snapshot (form, H2H, context). Public — no auth.",
    inputSchema: {
      id: z.number().int().positive().describe("Match ID"),
      includeIntelligence: z.boolean().optional().describe("Also fetch the /intelligence snapshot"),
    },
    annotations: READ,
  },
  async (p) => {
    try {
      const path = p.includeIntelligence ? `/api/matches/${p.id}/intelligence` : `/api/matches/${p.id}`;
      return ok(await api(path));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_matches_upcoming",
  {
    title: "Get Upcoming Matches",
    description: "Get scheduled matches for the next N days (1–30, default 7). Public — no auth.",
    inputSchema: { days: z.number().int().min(1).max(30).optional().describe("Days ahead (1–30, default 7)") },
    annotations: READ,
  },
  async (p) => {
    try { return ok(await api("/api/matches/upcoming", { params: { days: p.days } })); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_teams",
  {
    title: "Get Teams",
    description: "List teams known to FutPicks. Public — no auth.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try { return ok(await api("/api/teams")); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_track_record",
  {
    title: "Get Track Record",
    description:
      "Historical settled-pick performance with AND-combined filters: market, league, rating, outcome (Won/Lost/Push), and date range. " +
      "Returns hit rate, profit, and ROI. Public — no auth.",
    inputSchema: {
      market: z.string().optional().describe("Market display name (H2H, OU2.5, TT) or enum name"),
      league: z.string().optional().describe("League name (exact)"),
      rating: z.enum(["Good", "Marginal", "Weak"]).optional().describe("Filter by rating"),
      outcome: z.enum(["Won", "Lost", "Push"]).optional().describe("Filter by settled outcome"),
      from: z.string().optional().describe("Start date YYYY-MM-DD"),
      to: z.string().optional().describe("End date YYYY-MM-DD"),
      isLive: z.boolean().optional().describe("Live picks (true, default) vs preview/backtest (false)"),
    },
    annotations: READ,
  },
  async (p) => {
    try {
      return ok(await api("/api/track-record/filtered", {
        params: { market: p.market, league: p.league, rating: p.rating, outcome: p.outcome, from: p.from, to: p.to, isLive: p.isLive },
      }));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_health",
  {
    title: "Get System Health",
    description: "Check the FutPicks API health and basic system status. Public — no auth.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try { return ok(await api("/api/health")); } catch (e) { return err(e); }
  },
);

// ════════════════════════════════════════════════════════════════════════════
// DATA TOOLS (Pro tier — FUTPICKS_API_KEY)
// ════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "flab_picks_history",
  {
    title: "Get Picks History",
    description:
      "Paged history of past picks across all markets with filters. Requires Pro token (FUTPICKS_API_KEY).",
    inputSchema: {
      from: z.string().optional().describe("Start date YYYY-MM-DD"),
      to: z.string().optional().describe("End date YYYY-MM-DD"),
      league: z.string().optional().describe("Filter by league name"),
      market: z.string().optional().describe("Filter by market"),
      rating: z.enum(["Good", "Marginal", "Weak"]).optional().describe("Filter by rating"),
      isLive: z.boolean().optional().describe("Live (true, default) vs preview"),
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      pageSize: z.number().int().min(1).max(100).optional().describe("Page size (1–100, default 20)"),
    },
    annotations: READ,
  },
  async (p) => {
    try {
      return ok(await api("/api/picks/history", {
        auth: "data",
        params: { from: p.from, to: p.to, league: p.league, market: p.market, rating: p.rating, isLive: p.isLive, page: p.page, pageSize: p.pageSize },
      }));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_evaluate_matches",
  {
    title: "List Evaluable Matches",
    description:
      "List scheduled matches (next ~3 days) available for on-demand evaluation. Use the returned matchId with flab_evaluate_match. Requires Pro token.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try { return ok(await api("/api/evaluate/matches", { auth: "data" })); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_evaluate_match",
  {
    title: "Evaluate a Match",
    description:
      "Score a match on demand through the scoring engine and return every market's pick with the full block breakdown. Requires Pro token.",
    inputSchema: { matchId: z.number().int().positive().describe("Match ID (from flab_evaluate_matches)") },
    annotations: READ,
  },
  async (p) => {
    try { return ok(await api(`/api/evaluate/${p.matchId}`, { auth: "data" })); } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_backtest_run",
  {
    title: "Run a Backtest",
    description:
      "Run a backtest over settled picks for a date range with optional rating/market/edge/league filters. " +
      "Returns total picks, wins, losses, win rate, ROI, avg edge, and breakdowns. Requires Pro token. Range max 365 days.",
    inputSchema: {
      dateFrom: z.string().describe("Start date YYYY-MM-DD (inclusive)"),
      dateTo: z.string().describe("End date YYYY-MM-DD (must be after dateFrom)"),
      rating: z.enum(["Good", "Marginal", "Weak"]).optional().describe("Filter by rating"),
      market: z.string().optional().describe("Filter by market enum name (e.g. OU25, H2H3Way, BTTS)"),
      minEdge: z.number().optional().describe("Minimum edge threshold"),
      leagueId: z.number().int().optional().describe("Filter by league ID"),
    },
    annotations: WRITE,
  },
  async (p) => {
    try {
      return ok(await api("/api/backtest/run", {
        method: "POST",
        auth: "data",
        body: { dateFrom: p.dateFrom, dateTo: p.dateTo, rating: p.rating, market: p.market, minEdge: p.minEdge, leagueId: p.leagueId },
      }));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_export_picks",
  {
    title: "Export Picks (CSV)",
    description:
      "Export settled/published picks as CSV for a date range with optional market/rating filters. Returns raw CSV text. Requires Pro token.",
    inputSchema: {
      from: z.string().optional().describe("Start date YYYY-MM-DD"),
      to: z.string().optional().describe("End date YYYY-MM-DD"),
      market: z.string().optional().describe("Filter by market"),
      rating: z.enum(["Good", "Marginal", "Weak"]).optional().describe("Filter by rating"),
    },
    annotations: READ,
  },
  async (p) => {
    try {
      return ok(await api("/api/picks/export", { auth: "data", params: { from: p.from, to: p.to, market: p.market, rating: p.rating } }));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_data_catalog",
  {
    title: "Get Data Catalog",
    description: "Browse the Data API catalog: available datasets, scopes, and resources for Sharp/Pro consumers. Requires Pro token.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try { return ok(await api("/api/v1/data/catalog", { auth: "data" })); } catch (e) { return err(e); }
  },
);

// ════════════════════════════════════════════════════════════════════════════
// OPS TOOLS (Admin — FUTPICKS_OPS_TOKEN). Mutating; auto Idempotency-Key.
// ════════════════════════════════════════════════════════════════════════════

const OPS_KINDS = {
  "ingestion-runs": (a: OpsArgs) => ({ date: a.date }),
  "scoring-runs": (a: OpsArgs) => ({ date: a.date }),
  "settlement-runs": (a: OpsArgs) => ({ lastDays: a.lastDays ?? 3 }),
  "calibration-runs": (a: OpsArgs) => ({ windowDays: a.windowDays ?? 90 }),
  "intelligence-refreshes": (a: OpsArgs) => ({ matchId: a.matchId }),
} as const;

interface OpsArgs {
  date?: string;
  lastDays?: number;
  windowDays?: number;
  matchId?: number;
}

server.registerTool(
  "flab_ops_run",
  {
    title: "Run an Ops Operation (admin)",
    description:
      "Submit a pipeline operation. Returns 202 with an operation id to poll via flab_ops_status. Admin-only (FUTPICKS_OPS_TOKEN). " +
      "Kinds: ingestion-runs (date?), scoring-runs (date?), settlement-runs (lastDays 1–30), calibration-runs (windowDays 7–365), intelligence-refreshes (matchId).",
    inputSchema: {
      kind: z.enum(["ingestion-runs", "scoring-runs", "settlement-runs", "calibration-runs", "intelligence-refreshes"]).describe("Operation kind"),
      date: z.string().optional().describe("ISO date YYYY-MM-DD (ingestion/scoring; default today)"),
      lastDays: z.number().int().min(1).max(30).optional().describe("Settlement lookback days (1–30, default 3)"),
      windowDays: z.number().int().min(7).max(365).optional().describe("Calibration window days (7–365, default 90)"),
      matchId: z.number().int().positive().optional().describe("Match ID (intelligence-refreshes only)"),
    },
    annotations: WRITE,
  },
  async (p) => {
    try {
      const builder = OPS_KINDS[p.kind];
      const body = builder(p);
      return ok(await api(`/api/v1/ops/operations/${p.kind}`, { method: "POST", auth: "ops", body }));
    } catch (e) { return err(e); }
  },
);

server.registerTool(
  "flab_ops_status",
  {
    title: "Get Ops Operation Status (admin)",
    description:
      "Poll an operation's lifecycle status by id. Set includeResult=true to also fetch its result payload once complete. Admin-only (FUTPICKS_OPS_TOKEN).",
    inputSchema: {
      id: z.number().int().positive().describe("Operation id (from flab_ops_run)"),
      includeResult: z.boolean().optional().describe("Also fetch /result"),
    },
    annotations: READ,
  },
  async (p) => {
    try {
      const path = p.includeResult ? `/api/v1/ops/operations/${p.id}/result` : `/api/v1/ops/operations/${p.id}`;
      return ok(await api(path, { auth: "ops" }));
    } catch (e) { return err(e); }
  },
);

// ── Start ─────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("FutPicks MCP server running via stdio");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
