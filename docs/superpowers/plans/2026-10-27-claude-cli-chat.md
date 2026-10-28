# Claude CLI chat + subscription usage meter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Claude CLI" chat that drives the `claude` CLI headless and manages graph nodes and chats through an app-run MCP server (with approval cards, node merge, and undo), plus a top-bar subscription-limit meter fed by the CLI's `rate_limit_event`.

**Architecture:** Spec: `docs/superpowers/specs/2026-10-27-claude-cli-chat-design.md`. A turn POST spawns `claude -p --output-format stream-json` with hardened flags and a per-turn `--mcp-config` pointing at `POST /api/cli/mcp/<token>` (a hand-rolled JSON-RPC endpoint, no new dependency). CLI stream lines map to a small wire-event vocabulary (NDJSON to the browser); one pure reducer (`applyWireEvent`) builds messages on both server (persistence) and client (live render). Destructive tools block on an in-memory approval broker until the card is answered. Graph merge is a pure core function over the `GraphStore` port; snapshots + undo wrap graph writes.

**Tech Stack:** Next.js 16 route handlers, React 19, TypeScript, `node:test` via `tsx`, no new npm dependencies.

## Global Constraints

- **Import law (eslint, `docs/architecture.md` §2):** `components/**` imports only `@/src/core`; `app/**` imports only `@/src/core` + `@/src/server`; `src/core/**` never imports agent/server/store; `src/agent/**` never imports server/store (dependencies arrive via factories).
- **Core barrel is browser-safe:** modules importing `node:*` (graph-merge, ledger-snapshot) are imported directly by server code, never re-exported from `src/core/index.ts`.
- **Next.js here has breaking changes (AGENTS.md):** Task 1 reads `node_modules/next/dist/docs/` before any route handler is written. Route handlers follow the repo idiom: `export async function POST(req: Request, { params }: { params: Promise<{ id: string }> })`.
- **No new dependencies.** MCP is hand-rolled (owner decision 2026-10-27).
- **Hardened CLI flags (measured: 883 vs 405,260 cache tokens per turn, $0.0036 vs $1.62):** `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, own `--system-prompt-file`, fixed empty cwd.
- **Subscription, not API billing:** the runner deletes `ANTHROPIC_API_KEY` from the child env.
- **Tests:** `NODE_ENV=test npx tsx --test tests/<file>`; full gate `npm test`, `npm run lint`, `npm run typecheck`. Commands below use bash syntax (Git Bash).
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Data location:** all new mutable data lives under `PATHS.cli` (`data/cli`, relocatable via `LH_DATA_DIR`).

## Decisions beyond the spec (flag for owner review)

1. **Undo covers graph changes only** (node merge, node delete). Chat deletion removes chat records and job files that a ledger snapshot cannot restore, so restoring ledgers after it would leave provenance pointing at missing chats. The `delete_chats` approval card says "cannot be undone".
2. **Merged node `createdAt`** = earliest `createdAt` of the merged nodes (preserves birth-session semantics); merged node's position comes from the existing `settleGraphLayout`.
3. **Undo validity** = the graph revision (max ledger mtime, `graphRevision()`) recorded right after the change still equals the current revision.

## File Structure

| File | Responsibility |
|---|---|
| `config.ts` (modify) | add `PATHS.cli` |
| `src/core/contracts/cli.ts` (create) | all CLI-chat / usage / approval / undo types |
| `src/core/contracts.ts` (modify) | re-export `contracts/cli.ts` |
| `src/core/cli-usage.ts` (create) | parse `rate_limit_event`, staleness, percent, reset label |
| `src/core/cli-chat.ts` (create) | message constructors + `applyWireEvent` reducer |
| `src/core/graph-merge.ts` (create) | `previewMerge`, `mergeNodes` (pure over `GraphStore`) |
| `src/core/ledger-snapshot.ts` (create) | `snapshotLedgers`, `restoreLedgers` |
| `src/core/ports.ts` (modify) | `CliChatStore`, `CliStateStore` ports |
| `src/core/index.ts` (modify) | export `cli-usage`, `cli-chat` |
| `src/store/cli-chats.ts` (create) | fs adapter for CLI chats |
| `src/store/cli-state.ts` (create) | fs adapter for usage snapshot + undo record |
| `src/agent/cli/stream-map.ts` (create) | CLI stream-json line → wire events |
| `src/agent/cli/args.ts` (create) | hardened argv + system prompt text |
| `src/agent/cli/runner.ts` (create) | spawn + stream lines → run events |
| `src/agent/cli/mcp-rpc.ts` (create) | JSON-RPC handler + `CliTool` type |
| `src/agent/cli/tools.ts` (create) | the nine MCP tools (factory) |
| `src/server/graph-ops.ts` (create) | gated merge/delete/undo with snapshots |
| `src/server/cli-approvals.ts` (create) | approval broker |
| `src/server/cli-turn.ts` (create) | turn registry + `startCliTurn` |
| `src/server/cli.ts` (create) | composition root for the CLI feature |
| `src/server/stores.ts`, `src/server/index.ts` (modify) | wire + export |
| `app/api/cli/**` (create) | chats, turn, approvals, mcp, usage, undo routes |
| `app/cli/[id]/page.tsx` (create) | CLI chat page |
| `components/cli-format.ts` (create) | pure formatting for meter/cards |
| `components/usage-meter.tsx`, `components/cli-approval-card.tsx`, `components/cli-chat.tsx`, `components/cli-sidebar.tsx` (create) | UI |
| `components/top-bar.tsx`, `components/sidebar.tsx` (modify) | mount meter / sidebar section |
| `docs/architecture.md` (modify) | record the third ledger writer + CLI surface |

---

### Task 1: Environment, Next docs, and the CLI/MCP spike

**Files:**
- Create (scratch, not committed): `<scratchpad>/spike-mcp.mjs`
- Create: `tests/fixtures/cli/tool-run.jsonl`
- Modify: `docs/superpowers/specs/2026-10-27-claude-cli-chat-design.md` (append "Spike results")

**Interfaces:**
- Produces: confirmed facts used by later tasks — (a) the real CLI accepts an `http` MCP server and calls `tools/call`; (b) `MCP_TOOL_TIMEOUT` lets a tool call block ≥ 90 s; (c) real `tool_use` / `tool_result` stream shapes; (d) whether `spawn("claude", …)` works without a shell on this OS. **If (a) or (b) fails, STOP and report to the owner** — the fallback is a stdio shim and needs a design decision.

- [ ] **Step 1: Install dependencies and read the Next docs**

```bash
npm ci
ls node_modules/next/dist/docs
```
Read the route-handler and streaming-response guides in that folder (look for files about route handlers / `Response` streaming). Note any difference from `app/api/events/route.ts`'s idiom (`export const dynamic = "force-dynamic"`; `Response` with a `ReadableStream`).

- [ ] **Step 2: Write the spike server**

Write `<scratchpad>/spike-mcp.mjs` (scratchpad path is in the environment section):

```js
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DELAY_MS = Number(process.env.SPIKE_DELAY_MS ?? 0);
const server = http.createServer((req, res) => {
	if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", async () => {
		const msg = JSON.parse(body || "{}");
		console.error("MCP <-", msg.method);
		const json = (obj) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
		const reply = (result) => json({ jsonrpc: "2.0", id: msg.id, result });
		if (msg.id === undefined) { res.statusCode = 202; return res.end(); }
		if (msg.method === "initialize") return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "spike", version: "0" } });
		if (msg.method === "tools/list") return reply({ tools: [{ name: "ping_lh", description: "Returns pong", inputSchema: { type: "object", properties: {} } }] });
		if (msg.method === "tools/call") { await new Promise((r) => setTimeout(r, DELAY_MS)); return reply({ content: [{ type: "text", text: "pong" }] }); }
		json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-spike-"));
const cfg = path.join(dir, "mcp.json");
const sys = path.join(dir, "system.md");
fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { lh: { type: "http", url: `http://127.0.0.1:${port}/mcp` } } }));
fs.writeFileSync(sys, "You are a test helper. Use the provided tool when asked.");
const work = path.join(dir, "work"); fs.mkdirSync(work);
const env = { ...process.env, MCP_TOOL_TIMEOUT: "600000" }; delete env.ANTHROPIC_API_KEY;
const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--strict-mcp-config", "--mcp-config", cfg, "--allowedTools", "mcp__lh__ping_lh", "--setting-sources", "", "--disable-slash-commands", "--system-prompt-file", sys];
const child = spawn("claude", args, { cwd: work, env, stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (e) => console.error("SPAWN ERROR", e.code, e.message));
child.stdin.end("Call the ping_lh tool once, then tell me exactly what it returned.");
const out = fs.createWriteStream(process.env.SPIKE_OUT ?? "spike-out.jsonl");
child.stdout.pipe(out);
child.on("close", (code) => { console.error("claude exit", code); server.close(); });
```

- [ ] **Step 3: Run it twice (no delay, then 90 s delay)**

```bash
SPIKE_OUT="tests/fixtures/cli/tool-run.jsonl" SPIKE_DELAY_MS=0 node <scratchpad>/spike-mcp.mjs
SPIKE_OUT="<scratchpad>/slow.jsonl" SPIKE_DELAY_MS=90000 node <scratchpad>/spike-mcp.mjs
```
(Create `tests/fixtures/cli` first: `mkdir -p tests/fixtures/cli`.) Expected: stderr shows `MCP <- initialize`, `MCP <- tools/list`, `MCP <- tools/call`; exit 0 both times. Check:

```bash
grep -c '"tool_use"' tests/fixtures/cli/tool-run.jsonl
grep -o '"mcp_servers":\[[^]]*\]' tests/fixtures/cli/tool-run.jsonl | head -1
grep -c pong <scratchpad>/slow.jsonl
```
Expected: ≥1; server status `connected`; ≥1.

- [ ] **Step 4: Check spawn-without-shell and record the real shapes**

```bash
node -e "const {spawn}=require('node:child_process');const c=spawn('claude',['--version']);c.stdout.on('data',d=>console.log(String(d)));c.on('error',e=>console.log('ERR',e.code))"
grep -m1 '"type":"assistant".*tool_use' tests/fixtures/cli/tool-run.jsonl | cut -c1-500
grep -m1 '"type":"user".*tool_result' tests/fixtures/cli/tool-run.jsonl | cut -c1-500
```
Expected: version prints (no `ERR`). Confirm in the output that: assistant `message.content[]` has `{"type":"tool_use","id","name":"mcp__lh__ping_lh","input"}`, and a `user` line carries `message.content[]` `{"type":"tool_result","tool_use_id",…,"content"}`. If any of these differ from the assumptions in Task 6's mapper, adjust Task 6's tests/code to the real shapes before implementing.

- [ ] **Step 5: Record results and commit**

Append to the spec a `## Spike results` section with: MCP http accepted (yes/no), 90 s tool call survived (yes/no), spawn without shell (yes/no), the real tool_use/tool_result shape lines (one sentence each). Then:

```bash
git add tests/fixtures/cli/tool-run.jsonl docs/superpowers/specs/2026-10-27-claude-cli-chat-design.md
git commit -m "docs: record Claude CLI / MCP spike results and fixture

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Contracts, config path, usage parsing, message reducer

**Files:**
- Create: `src/core/contracts/cli.ts`, `src/core/cli-usage.ts`, `src/core/cli-chat.ts`
- Modify: `config.ts` (add `PATHS.cli`), `src/core/contracts.ts` (line ~13: add re-export), `src/core/index.ts` (add two exports)
- Test: `tests/cli-usage.test.ts`, `tests/cli-chat-reducer.test.ts`

**Interfaces:**
- Produces (all exported from `@/src/core`): types `UsageWindow`, `UsageSnapshot`, `CliToolCall`, `CliApproval`, `CliApprovalEdit`, `CliPart`, `CliMessage`, `CliChatRecord`, `CliChatSummary`, `CliWireEvent`, `CliApprovalRequest`, `CliApprovalDecision`, `LedgerSnapshot`, `UndoRecord`, `CliOpResult<T>`; functions `parseRateLimitEvent(raw: unknown, now?: Date): UsageSnapshot | null`, `isUsageStale(s: UsageSnapshot, nowMs: number, maxAgeMs?: number): boolean`, `usagePercent(w: UsageWindow): number`, `resetLabel(w: UsageWindow, nowMs: number): string`, `newCliMessage(role, id, createdAt, text?): CliMessage`, `applyWireEvent(msg: CliMessage, ev: CliWireEvent): CliMessage`.

- [ ] **Step 1: Write the contracts**

`src/core/contracts/cli.ts`:

```ts
/**
 * Claude CLI chat contracts — the chat record, the NDJSON wire vocabulary a
 * turn streams to the browser, the plan-limit snapshot, and the graph undo
 * record. Pure types; the reducer is core/cli-chat.ts.
 */
import type { CoverageEntry, GraphChain, GraphNode, Position, SessionCheckpoint } from "./graph.ts";

/** One plan window as reported by the CLI's rate_limit_event. */
export interface UsageWindow {
	/** 0..1 fraction of the window used. */
	utilization: number;
	/** Epoch SECONDS when the window resets. */
	resetsAt: number;
	status: string;
}

export interface UsageSnapshot {
	fiveHour: UsageWindow | null;
	sevenDay: UsageWindow | null;
	/** ISO — when the CLI reported it (drives the "as of" staleness label). */
	capturedAt: string;
}

export interface CliToolCall {
	id: string;
	/** Tool name WITHOUT the mcp__lh__ prefix. */
	name: string;
	input: unknown;
	status: "running" | "done" | "error";
	output?: string;
}

export interface CliApprovalEdit {
	name: string;
	statement: string;
}

export interface CliApproval {
	id: string;
	tool: string;
	title: string;
	lines: string[];
	/** Present for merge_nodes: the proposed identity, editable before approving. */
	edit?: CliApprovalEdit;
	status: "pending" | "approved" | "rejected";
}

export type CliPart =
	| { type: "text"; text: string }
	| { type: "tool"; call: CliToolCall }
	| { type: "approval"; approval: CliApproval }
	| { type: "error"; message: string };

export interface CliMessage {
	id: string;
	role: "user" | "assistant";
	parts: CliPart[];
	createdAt: string;
}

export interface CliChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** The Claude CLI session id this chat resumes. */
	cliSessionId?: string;
	messages: CliMessage[];
}

export interface CliChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

/** What a turn streams (NDJSON, one object per line). */
export type CliWireEvent =
	| { type: "text"; delta: string }
	| { type: "tool-start"; id: string; name: string; input: unknown }
	| { type: "tool-end"; id: string; output: string; isError: boolean }
	| { type: "approval"; approval: CliApproval }
	| { type: "approval-settled"; id: string; approved: boolean }
	| { type: "usage"; usage: UsageSnapshot }
	| { type: "error"; message: string }
	| { type: "done" };

/** What a destructive tool asks the broker to put in front of the learner. */
export interface CliApprovalRequest {
	tool: string;
	title: string;
	lines: string[];
	edit?: CliApprovalEdit;
}

export type CliApprovalDecision = { approved: false } | { approved: true; edit?: CliApprovalEdit };

/** The five rewritable graph ledgers, captured verbatim. */
export interface LedgerSnapshot {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
	positions: Record<string, Position>;
}

/** The single latest undo point. */
export interface UndoRecord {
	id: string;
	label: string;
	at: string;
	/** graphRevision() right after the change; undo is valid only while it still matches. */
	revisionAfter: number;
	ledgers: LedgerSnapshot;
}

export type CliOpResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string };
```

In `src/core/contracts.ts` add after the existing `export * from "./contracts/graph.ts";` line:

```ts
export * from "./contracts/cli.ts";
```

In `src/core/index.ts` add after `export * from "./chains.ts";`:

```ts
export * from "./cli-usage.ts";
export * from "./cli-chat.ts";
```

In `config.ts` `PATHS` object add after `graph:`:

```ts
	/** Claude CLI feature data: chats/, work/ (empty cwd for the CLI), usage.json, undo.json. */
	cli: path.join(DATA_ROOT, "cli"),
```

- [ ] **Step 2: Write the failing usage tests**

`tests/cli-usage.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUsageStale, parseRateLimitEvent, resetLabel, usagePercent } from "../src/core/cli-usage.ts";

const event = {
	type: "rate_limit_event",
	rate_limit_info: {
		status: "allowed",
		unifiedWindows: {
			five_hour: { utilization: 0.12, resetsAt: 1793153400, status: "allowed" },
			seven_day: { utilization: 0.29, resetsAt: 1793170800, status: "allowed" },
		},
	},
};
const now = new Date("2026-10-27T12:00:00.000Z");

describe("parseRateLimitEvent", () => {
	it("reads both windows and stamps capturedAt", () => {
		const s = parseRateLimitEvent(event, now)!;
		assert.equal(s.fiveHour!.utilization, 0.12);
		assert.equal(s.sevenDay!.resetsAt, 1793170800);
		assert.equal(s.capturedAt, now.toISOString());
	});
	it("keeps a missing window as null", () => {
		const one = { ...event, rate_limit_info: { unifiedWindows: { five_hour: event.rate_limit_info.unifiedWindows.five_hour } } };
		const s = parseRateLimitEvent(one, now)!;
		assert.equal(s.sevenDay, null);
	});
	it("ignores a window with a non-numeric utilization", () => {
		const bad = { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: "x", resetsAt: 1, status: "a" } } } };
		assert.equal(parseRateLimitEvent(bad, now), null);
	});
	it("returns null for other line types and junk", () => {
		assert.equal(parseRateLimitEvent({ type: "assistant" }, now), null);
		assert.equal(parseRateLimitEvent(null, now), null);
		assert.equal(parseRateLimitEvent("x", now), null);
	});
});

describe("usage helpers", () => {
	it("usagePercent rounds the fraction", () => {
		assert.equal(usagePercent({ utilization: 0.285, resetsAt: 0, status: "" }), 29);
		assert.equal(usagePercent({ utilization: 0, resetsAt: 0, status: "" }), 0);
	});
	it("isUsageStale compares capturedAt to now (default 5 minutes)", () => {
		const s = parseRateLimitEvent(event, now)!;
		assert.equal(isUsageStale(s, now.getTime() + 4 * 60_000), false);
		assert.equal(isUsageStale(s, now.getTime() + 6 * 60_000), true);
	});
	it("resetLabel formats minutes, hours and days", () => {
		const at = (ms: number) => ({ utilization: 0, resetsAt: (now.getTime() + ms) / 1000, status: "" });
		assert.equal(resetLabel(at(45 * 60_000), now.getTime()), "resets in 45m");
		assert.equal(resetLabel(at(125 * 60_000), now.getTime()), "resets in 2h 05m");
		assert.equal(resetLabel(at(26 * 3_600_000), now.getTime()), "resets in 1d 2h");
		assert.equal(resetLabel(at(-1000), now.getTime()), "resetting");
	});
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/cli-usage.test.ts`
Expected: FAIL — cannot find module `../src/core/cli-usage.ts`.

- [ ] **Step 4: Implement `cli-usage.ts`**

```ts
/**
 * Plan-limit usage helpers (Claude CLI rate_limit_event). Pure, browser-safe.
 * The CLI reports utilization as a 0..1 fraction per window.
 */
import type { UsageSnapshot, UsageWindow } from "./contracts/cli.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function readWindow(v: unknown): UsageWindow | null {
	if (!isRecord(v)) return null;
	if (typeof v.utilization !== "number" || !Number.isFinite(v.utilization)) return null;
	if (typeof v.resetsAt !== "number" || !Number.isFinite(v.resetsAt)) return null;
	return { utilization: v.utilization, resetsAt: v.resetsAt, status: typeof v.status === "string" ? v.status : "" };
}

/** A rate_limit_event stream line → snapshot; null when it isn't one or carries no usable window. */
export function parseRateLimitEvent(raw: unknown, now: Date = new Date()): UsageSnapshot | null {
	if (!isRecord(raw) || raw.type !== "rate_limit_event" || !isRecord(raw.rate_limit_info)) return null;
	const windows = raw.rate_limit_info.unifiedWindows;
	if (!isRecord(windows)) return null;
	const fiveHour = readWindow(windows.five_hour);
	const sevenDay = readWindow(windows.seven_day);
	if (fiveHour === null && sevenDay === null) return null;
	return { fiveHour, sevenDay, capturedAt: now.toISOString() };
}

export function isUsageStale(s: UsageSnapshot, nowMs: number, maxAgeMs = 5 * 60_000): boolean {
	return nowMs - Date.parse(s.capturedAt) > maxAgeMs;
}

export function usagePercent(w: UsageWindow): number {
	return Math.round(w.utilization * 100);
}

export function resetLabel(w: UsageWindow, nowMs: number): string {
	const ms = w.resetsAt * 1000 - nowMs;
	if (ms <= 0) return "resetting";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `resets in ${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
	return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
```

- [ ] **Step 5: Run usage tests — expect PASS**

Run: `NODE_ENV=test npx tsx --test tests/cli-usage.test.ts` → all pass.

- [ ] **Step 6: Write the failing reducer tests**

`tests/cli-chat-reducer.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyWireEvent, newCliMessage } from "../src/core/cli-chat.ts";

const base = () => newCliMessage("assistant", "m1", "2026-10-27T00:00:00.000Z");
const approval = { id: "a1", tool: "merge_nodes", title: "Merge", lines: ["x"], status: "pending" as const };

describe("applyWireEvent", () => {
	it("appends text deltas to the trailing text part", () => {
		let m = base();
		m = applyWireEvent(m, { type: "text", delta: "Hel" });
		m = applyWireEvent(m, { type: "text", delta: "lo" });
		assert.deepEqual(m.parts, [{ type: "text", text: "Hello" }]);
	});
	it("starts a new text part after a tool part", () => {
		let m = base();
		m = applyWireEvent(m, { type: "text", delta: "a" });
		m = applyWireEvent(m, { type: "tool-start", id: "t1", name: "list_nodes", input: {} });
		m = applyWireEvent(m, { type: "text", delta: "b" });
		assert.equal(m.parts.length, 3);
		assert.deepEqual(m.parts[2], { type: "text", text: "b" });
	});
	it("tool-end settles the matching call (done / error)", () => {
		let m = base();
		m = applyWireEvent(m, { type: "tool-start", id: "t1", name: "x", input: {} });
		m = applyWireEvent(m, { type: "tool-end", id: "t1", output: "ok", isError: false });
		const part = m.parts[0]!;
		assert.ok(part.type === "tool" && part.call.status === "done" && part.call.output === "ok");
		m = applyWireEvent(m, { type: "tool-start", id: "t2", name: "y", input: {} });
		m = applyWireEvent(m, { type: "tool-end", id: "t2", output: "bad", isError: true });
		const p2 = m.parts[1]!;
		assert.ok(p2.type === "tool" && p2.call.status === "error");
	});
	it("approval then approval-settled flips status", () => {
		let m = base();
		m = applyWireEvent(m, { type: "approval", approval });
		m = applyWireEvent(m, { type: "approval-settled", id: "a1", approved: true });
		const part = m.parts[0]!;
		assert.ok(part.type === "approval" && part.approval.status === "approved");
		m = applyWireEvent(m, { type: "approval", approval: { ...approval, id: "a2" } });
		m = applyWireEvent(m, { type: "approval-settled", id: "a2", approved: false });
		const p2 = m.parts[1]!;
		assert.ok(p2.type === "approval" && p2.approval.status === "rejected");
	});
	it("error adds an error part; usage and done leave the message untouched", () => {
		let m = base();
		m = applyWireEvent(m, { type: "error", message: "boom" });
		assert.deepEqual(m.parts, [{ type: "error", message: "boom" }]);
		const before = m;
		assert.equal(applyWireEvent(m, { type: "done" }), before);
		assert.equal(applyWireEvent(m, { type: "usage", usage: { fiveHour: null, sevenDay: null, capturedAt: "x" } }), before);
	});
	it("does not mutate its input", () => {
		const m = base();
		applyWireEvent(m, { type: "text", delta: "z" });
		assert.deepEqual(m.parts, []);
	});
});
```

- [ ] **Step 7: Run to verify failure, then implement `cli-chat.ts`**

Run: `NODE_ENV=test npx tsx --test tests/cli-chat-reducer.test.ts` → FAIL (module missing). Then:

```ts
/**
 * CLI chat message building — ONE pure reducer shared by the server (to
 * persist a turn) and the browser (to render it live), so the two can never
 * disagree about what a stream means.
 */
import type { CliMessage, CliPart, CliWireEvent } from "./contracts/cli.ts";

export function newCliMessage(role: CliMessage["role"], id: string, createdAt: string, text?: string): CliMessage {
	return { id, role, createdAt, parts: text === undefined ? [] : [{ type: "text", text }] };
}

export function applyWireEvent(msg: CliMessage, ev: CliWireEvent): CliMessage {
	const parts = msg.parts;
	switch (ev.type) {
		case "text": {
			const last = parts[parts.length - 1];
			if (last?.type === "text") {
				return { ...msg, parts: [...parts.slice(0, -1), { type: "text", text: last.text + ev.delta }] };
			}
			return { ...msg, parts: [...parts, { type: "text", text: ev.delta }] };
		}
		case "tool-start":
			return { ...msg, parts: [...parts, { type: "tool", call: { id: ev.id, name: ev.name, input: ev.input, status: "running" } }] };
		case "tool-end":
			return {
				...msg,
				parts: parts.map(
					(p): CliPart =>
						p.type === "tool" && p.call.id === ev.id
							? { type: "tool", call: { ...p.call, status: ev.isError ? "error" : "done", output: ev.output } }
							: p,
				),
			};
		case "approval":
			return { ...msg, parts: [...parts, { type: "approval", approval: ev.approval }] };
		case "approval-settled":
			return {
				...msg,
				parts: parts.map(
					(p): CliPart =>
						p.type === "approval" && p.approval.id === ev.id
							? { type: "approval", approval: { ...p.approval, status: ev.approved ? "approved" : "rejected" } }
							: p,
				),
			};
		case "error":
			return { ...msg, parts: [...parts, { type: "error", message: ev.message }] };
		case "usage":
		case "done":
			return msg;
	}
}
```

- [ ] **Step 8: Run both tests, typecheck, commit**

```bash
NODE_ENV=test npx tsx --test tests/cli-usage.test.ts tests/cli-chat-reducer.test.ts
npm run typecheck
git add config.ts src/core tests/cli-usage.test.ts tests/cli-chat-reducer.test.ts
git commit -m "feat(cli): contracts, usage parsing, and message reducer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: tests pass, typecheck clean.

---

### Task 3: Node merge (pure core)

**Files:**
- Create: `src/core/graph-merge.ts`
- Test: `tests/graph-merge.test.ts`

**Interfaces:**
- Consumes: `GraphStore` (`src/core/ports.ts`), `GraphNode`, `GraphChain`, `Position`.
- Produces: `interface MergeInput { ids: string[]; name: string; statement: string }`; `interface MergePreview { found: Array<{ id: string; name: string }>; missing: string[]; chainsRewritten: number; chainsDropped: number }`; `interface MergeStats { nodesMerged: number; chainsRewritten: number; chainsDropped: number }`; `previewMerge(store: Pick<GraphStore,"readNodes"|"readChains">, ids: string[]): MergePreview`; `mergeNodes(store: GraphStore, input: MergeInput, opts?: { newId?: string; now?: string }): CliOpResult<{ newId: string } & MergeStats>`. Chain counts are DISTINCT chain ids (`arg_…`).

**Semantics (from the spec):** merged node gets the supplied name/statement; aliases = union of all old names, statements, aliases (deduped, excluding the new name and statement); provenance = union (deduped by chatId+messageId, old order); `createdAt` = earliest. Every chain line referencing a merged id is re-pointed; premises deduped; a line whose conclusion is the merged id and whose premises become only the merged id (or conclusion ∈ premises) is dropped; lines sharing a chain key after remap share one chain id (first wins). Old nodes' lines removed; positions of old nodes and dead chains removed. The merged node has no position (the caller runs `settleGraphLayout`).

- [ ] **Step 1: Write the failing tests (in-memory fake store)**

`tests/graph-merge.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, Position } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { mergeNodes, previewMerge } from "../src/core/graph-merge.ts";

function fakeStore(nodes: GraphNode[], chains: GraphChain[], positions: Record<string, Position> = {}) {
	const state = { nodes, chains, coverage: [] as never[], checkpoints: [] as never[], positions };
	const store = {
		readNodes: () => state.nodes,
		readChains: () => state.chains,
		readPositions: () => state.positions,
		writePositions: (p: Record<string, Position>) => { state.positions = p; },
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[] }) => {
			if (next.nodes) state.nodes = next.nodes;
			if (next.chains) state.chains = next.chains;
		},
	} as unknown as GraphStore;
	return { store, state };
}
const node = (id: string, name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
	id, name, statement: `${name} statement`, aliases: [], createdAt: "2026-01-02T00:00:00.000Z",
	provenance: [{ chatId: "c1", messageId: id }], ...extra,
});
const chain = (id: string, premises: string[], conclusion: string, chatId = "c1"): GraphChain => ({
	id, premises, conclusion, createdAt: "2026-01-02T00:00:00.000Z", provenance: [{ chatId, messageId: id }],
});
const input = { ids: ["n_a", "n_b"], name: "Merged", statement: "Merged statement" };

describe("previewMerge", () => {
	it("counts rewritten and dropped chains by distinct chain id and reports missing ids", () => {
		const { store } = fakeStore(
			[node("n_a", "A"), node("n_b", "B"), node("n_c", "C")],
			[chain("arg_1", ["n_a"], "n_c"), chain("arg_2", ["n_a"], "n_b"), chain("arg_3", ["n_c"], "n_c2")],
		);
		const p = previewMerge(store, ["n_a", "n_b", "n_zzz"]);
		assert.deepEqual(p.found.map((f) => f.id), ["n_a", "n_b"]);
		assert.deepEqual(p.missing, ["n_zzz"]);
		assert.equal(p.chainsRewritten, 1);
		assert.equal(p.chainsDropped, 1);
	});
});

describe("mergeNodes", () => {
	it("creates one node with the new identity, unioned aliases and provenance, earliest createdAt", () => {
		const { store, state } = fakeStore(
			[
				node("n_a", "A", { aliases: ["a-alias"], createdAt: "2026-01-05T00:00:00.000Z" }),
				node("n_b", "B", { createdAt: "2026-01-01T00:00:00.000Z", provenance: [{ chatId: "c1", messageId: "n_a" }, { chatId: "c2", messageId: "x" }] }),
				node("n_c", "C"),
			],
			[],
		);
		const r = mergeNodes(store, input, { newId: "n_new", now: "2026-10-27T00:00:00.000Z" });
		assert.ok(r.ok);
		const merged = state.nodes.find((n) => n.id === "n_new")!;
		assert.equal(merged.name, "Merged");
		assert.equal(merged.statement, "Merged statement");
		assert.equal(merged.createdAt, "2026-01-01T00:00:00.000Z");
		assert.deepEqual([...merged.aliases].sort(), ["A", "A statement", "B", "B statement", "a-alias"].sort());
		assert.deepEqual(merged.provenance, [{ chatId: "c1", messageId: "n_a" }, { chatId: "c2", messageId: "x" }]);
		assert.deepEqual(state.nodes.map((n) => n.id).sort(), ["n_c", "n_new"]);
	});

	it("re-points chains, dedupes premises, drops self-referential chains", () => {
		const { store, state } = fakeStore(
			[node("n_a", "A"), node("n_b", "B"), node("n_c", "C")],
			[
				chain("arg_1", ["n_a", "n_c"], "n_x"),
				chain("arg_2", ["n_a"], "n_b"), // becomes new ⟹ new: dropped
				chain("arg_3", ["n_a", "n_b"], "n_x"), // premises collapse to [new]
				chain("arg_4", ["n_c"], "n_x"), // untouched
			],
		);
		const r = mergeNodes(store, input, { newId: "n_new" });
		assert.ok(r.ok);
		if (r.ok) {
			assert.equal(r.value.chainsRewritten, 2);
			assert.equal(r.value.chainsDropped, 1);
		}
		const byId = new Map(state.chains.map((c) => [c.id, c]));
		assert.deepEqual(byId.get("arg_1")!.premises, ["n_new", "n_c"]);
		assert.ok(!byId.has("arg_2"));
		assert.deepEqual(byId.get("arg_3")!.premises, ["n_new"]);
		assert.deepEqual(byId.get("arg_4")!.premises, ["n_c"]);
	});

	it("lines that collide on (premises, conclusion) after remap share the first chain id", () => {
		const { store, state } = fakeStore(
			[node("n_a", "A"), node("n_b", "B")],
			[chain("arg_1", ["n_a"], "n_x", "c1"), chain("arg_2", ["n_b"], "n_x", "c2")],
		);
		mergeNodes(store, input, { newId: "n_new" });
		assert.deepEqual(state.chains.map((c) => c.id), ["arg_1", "arg_1"]);
		assert.deepEqual(state.chains.map((c) => c.provenance[0]!.chatId), ["c1", "c2"]);
	});

	it("prunes positions of merged nodes and dead chains", () => {
		const { store, state } = fakeStore(
			[node("n_a", "A"), node("n_b", "B"), node("n_c", "C")],
			[chain("arg_2", ["n_a"], "n_b")],
			{ n_a: { x: 1, y: 1 }, n_b: { x: 2, y: 2 }, n_c: { x: 3, y: 3 }, arg_2: { x: 4, y: 4 } },
		);
		mergeNodes(store, input, { newId: "n_new" });
		assert.deepEqual(Object.keys(state.positions), ["n_c"]);
	});

	it("rejects: fewer than two distinct existing ids, unknown ids, blank identity", () => {
		const { store, state } = fakeStore([node("n_a", "A"), node("n_b", "B")], []);
		const before = JSON.stringify(state);
		for (const bad of [
			{ ...input, ids: ["n_a"] },
			{ ...input, ids: ["n_a", "n_a"] },
			{ ...input, ids: ["n_a", "n_zzz"] },
			{ ...input, name: "  " },
			{ ...input, statement: "" },
		]) {
			const r = mergeNodes(store, bad, { newId: "n_new" });
			assert.equal(r.ok, false);
		}
		assert.equal(JSON.stringify(state), before, "a rejected merge writes nothing");
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx tsx --test tests/graph-merge.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/core/graph-merge.ts`**

```ts
/**
 * Node merge — the third ledger writer (after extraction and deletion),
 * held to the same discipline as core/graph-deletion.ts: pure code over the
 * GraphStore port, no LLM judgment, deterministic, ONE synchronous block
 * (no awaits) so nothing interleaves between read and rewrite. The caller
 * owns the gates (extraction running → refuse) and the layout settle.
 *
 * The merged node's identity (name/statement) is SUPPLIED by the caller —
 * the old names, statements and aliases all survive as aliases, and the
 * provenance unions, so no phrasing or session link is lost.
 */
import { randomBytes } from "node:crypto";
import type { CliOpResult } from "./contracts/cli.ts";
import type { GraphChain, GraphNode, ProvenancePoint } from "./contracts.ts";
import type { GraphStore } from "./ports.ts";

export interface MergeInput {
	ids: string[];
	name: string;
	statement: string;
}

export interface MergePreview {
	found: Array<{ id: string; name: string }>;
	missing: string[];
	/** Distinct chains (arg_ ids) that survive re-pointed at the merged node. */
	chainsRewritten: number;
	/** Distinct chains that die (they would become self-referential). */
	chainsDropped: number;
}

export interface MergeStats {
	nodesMerged: number;
	chainsRewritten: number;
	chainsDropped: number;
}

type Reader = Pick<GraphStore, "readNodes" | "readChains">;

const chainKey = (premises: ReadonlyArray<string>, conclusion: string): string =>
	`${[...premises].sort().join("+")}>${conclusion}`;

interface Remap {
	lines: GraphChain[];
	rewritten: Set<string>;
	dropped: Set<string>;
}

/** Re-point every chain line at `newId`; drop self-referential lines; make
 *  lines that now share a key share one chain id (first wins). */
function remapChains(chains: GraphChain[], merged: ReadonlySet<string>, newId: string): Remap {
	const touches = (c: GraphChain) => merged.has(c.conclusion) || c.premises.some((p) => merged.has(p));
	const out: GraphChain[] = [];
	const rewritten = new Set<string>();
	const dropped = new Set<string>();
	const idOfKey = new Map<string, string>();
	// Keys of untouched lines claim their ids first so a remapped line joining
	// an existing argument reuses that argument's id.
	for (const c of chains) if (!touches(c) && !idOfKey.has(chainKey(c.premises, c.conclusion))) idOfKey.set(chainKey(c.premises, c.conclusion), c.id);
	for (const c of chains) {
		if (!touches(c)) { out.push(c); continue; }
		const conclusion = merged.has(c.conclusion) ? newId : c.conclusion;
		const premises = [...new Set(c.premises.map((p) => (merged.has(p) ? newId : p)))].filter((p) => p !== conclusion);
		if (premises.length === 0) { dropped.add(c.id); continue; }
		const key = chainKey(premises, conclusion);
		const id = idOfKey.get(key) ?? c.id;
		idOfKey.set(key, id);
		rewritten.add(c.id);
		out.push({ ...c, id, premises, conclusion });
	}
	// An id counts as dropped only if NONE of its lines survived.
	for (const id of [...dropped]) if (rewritten.has(id)) dropped.delete(id);
	return { lines: out, rewritten, dropped };
}

export function previewMerge(store: Reader, ids: string[]): MergePreview {
	const wanted = [...new Set(ids)];
	const byId = new Map<string, GraphNode>();
	for (const n of store.readNodes()) if (!byId.has(n.id)) byId.set(n.id, n);
	const found = wanted.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)!.name }));
	const missing = wanted.filter((id) => !byId.has(id));
	const { rewritten, dropped } = remapChains(store.readChains(), new Set(found.map((f) => f.id)), "__preview__");
	return { found, missing, chainsRewritten: rewritten.size, chainsDropped: dropped.size };
}

export function mergeNodes(
	store: GraphStore,
	input: MergeInput,
	opts: { newId?: string; now?: string } = {},
): CliOpResult<{ newId: string } & MergeStats> {
	const name = input.name.trim();
	const statement = input.statement.trim();
	if (name === "" || statement === "") return { ok: false, code: "bad_identity", error: "A merged node needs a non-empty name and statement" };
	const ids = [...new Set(input.ids)];
	if (ids.length < 2) return { ok: false, code: "too_few", error: "Merging needs at least two distinct node ids" };

	const nodeLines = store.readNodes();
	const known = new Set(nodeLines.map((n) => n.id));
	const missing = ids.filter((id) => !known.has(id));
	if (missing.length > 0) return { ok: false, code: "not_found", error: `Unknown node ids: ${missing.join(", ")}` };

	const mergedIds = new Set(ids);
	const newId = opts.newId ?? `n_${randomBytes(6).toString("hex")}`;
	const sources = nodeLines.filter((n) => mergedIds.has(n.id));

	const aliases: string[] = [];
	const seenAlias = new Set([name, statement]);
	for (const line of sources) {
		for (const phrasing of [line.name, line.statement, ...line.aliases]) {
			if (phrasing.length > 0 && !seenAlias.has(phrasing)) { seenAlias.add(phrasing); aliases.push(phrasing); }
		}
	}
	const provenance: ProvenancePoint[] = [];
	const seenPoint = new Set<string>();
	for (const line of sources) {
		for (const pt of line.provenance) {
			const k = `${pt.chatId}\u0000${pt.messageId}`;
			if (!seenPoint.has(k)) { seenPoint.add(k); provenance.push(pt); }
		}
	}
	const createdAt = sources.map((n) => n.createdAt).sort()[0]!;
	const mergedNode: GraphNode = { id: newId, name, statement, aliases, createdAt, provenance };

	const chainLines = store.readChains();
	const remap = remapChains(chainLines, mergedIds, newId);
	const dead = new Set(remap.dropped);

	store.rewriteLedgers({
		nodes: [...nodeLines.filter((n) => !mergedIds.has(n.id)), mergedNode],
		chains: remap.lines,
	});

	const positions = store.readPositions();
	const kept = Object.fromEntries(Object.entries(positions).filter(([id]) => !mergedIds.has(id) && !dead.has(id)));
	if (Object.keys(kept).length !== Object.keys(positions).length) store.writePositions(kept);

	return {
		ok: true,
		value: {
			newId,
			nodesMerged: ids.length,
			chainsRewritten: remap.rewritten.size,
			chainsDropped: remap.dropped.size,
		},
	};
}
```

`remapChains` already removes an id from `dropped` when any of its lines survived, so the two sets are disjoint and the counts are plain set sizes.

- [ ] **Step 4: Run tests until they pass**

Run: `NODE_ENV=test npx tsx --test tests/graph-merge.test.ts`. Expected: all pass. The `dropped` positions test relies on `dead` containing `arg_2`.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm run lint
git add src/core/graph-merge.ts tests/graph-merge.test.ts
git commit -m "feat(graph): pure node merge over the GraphStore port

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Ledger snapshots, CLI stores, gated graph ops, undo

**Files:**
- Create: `src/core/ledger-snapshot.ts`, `src/store/cli-chats.ts`, `src/store/cli-state.ts`, `src/server/graph-ops.ts`
- Modify: `src/core/ports.ts` (append two ports)
- Test: `tests/ledger-snapshot.test.ts`, `tests/cli-stores.test.ts`, `tests/graph-ops.test.ts`

**Interfaces:**
- Consumes: Task 2 contracts, Task 3 `mergeNodes`, `deleteNodeTraces` (`src/core/graph-deletion.ts`), `settleGraphLayout` shape `(graphStore) => void`.
- Produces:
  - `snapshotLedgers(store: GraphStore): LedgerSnapshot`; `restoreLedgers(store: GraphStore, snap: LedgerSnapshot): void`.
  - Ports in `ports.ts`:
    ```ts
    export interface CliChatStore {
    	create(title?: string): CliChatRecord;
    	get(id: string): CliChatRecord | null;
    	list(): CliChatSummary[];
    	save(id: string, patch: { messages?: CliMessage[]; cliSessionId?: string }): CliChatRecord;
    	rename(id: string, title: string): CliChatRecord;
    	delete(id: string): boolean;
    }
    export interface CliStateStore {
    	readUsage(): UsageSnapshot | null;
    	writeUsage(s: UsageSnapshot): void;
    	readUndo(): UndoRecord | null;
    	writeUndo(r: UndoRecord): void;
    	clearUndo(): void;
    }
    ```
  - `createCliChatStore(dir: string): CliChatStore`, `createCliStateStore(dir: string): CliStateStore`, constant `DEFAULT_CLI_TITLE = "New CLI chat"` (exported from `src/core/contracts/cli.ts` — add it there).
  - `createGraphOps(deps: GraphOpsDeps)` with `GraphOpsDeps = { graphStore: GraphStore; state: Pick<CliStateStore,"writeUndo"|"readUndo"|"clearUndo">; extractionBusy(): boolean; revision(): number; settle(): void; now?(): Date }` returning `{ mergeNodes(input: MergeInput): CliOpResult<{ newId: string } & MergeStats>; deleteNodes(ids: string[]): CliOpResult<{ deleted: string[]; missing: string[]; chainsRemoved: number }>; undoInfo(): { label: string; at: string } | null; undo(): CliOpResult<{ label: string }> }`.
  - Error codes: `extraction_running` (gate), `nothing_to_undo`, `stale` (revision moved), plus the merge codes from Task 3.

- [ ] **Step 1: Add the title constant and ports**

Append to `src/core/contracts/cli.ts`: `export const DEFAULT_CLI_TITLE = "New CLI chat";`

In `src/core/ports.ts` add imports `CliChatRecord, CliChatSummary, CliMessage, UndoRecord, UsageSnapshot` to the existing `./contracts.ts` import list, and append the two interfaces above at the end of the file.

- [ ] **Step 2: Write failing snapshot test**

`tests/ledger-snapshot.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphStore } from "../src/core/ports.ts";
import { restoreLedgers, snapshotLedgers } from "../src/core/ledger-snapshot.ts";

function store() {
	const s = {
		nodes: [{ id: "n1" }], chains: [{ id: "arg_1" }], coverage: [{ chatId: "c" }], checkpoints: [{ chatId: "c" }], positions: { n1: { x: 1, y: 2 } } as Record<string, { x: number; y: number }>,
	};
	const port = {
		readNodes: () => s.nodes, readChains: () => s.chains, readCoverage: () => s.coverage, readCheckpoints: () => s.checkpoints,
		readPositions: () => s.positions, writePositions: (p: typeof s.positions) => { s.positions = p; },
		rewriteLedgers: (n: Partial<typeof s>) => Object.assign(s, n),
	} as unknown as GraphStore;
	return { s, port };
}

describe("ledger snapshot", () => {
	it("round-trips all five ledgers and is a deep copy", () => {
		const { s, port } = store();
		const snap = snapshotLedgers(port);
		s.nodes = []; s.chains = []; s.coverage = []; s.checkpoints = []; s.positions = {};
		restoreLedgers(port, snap);
		assert.deepEqual(s.nodes, [{ id: "n1" }]);
		assert.deepEqual(s.chains, [{ id: "arg_1" }]);
		assert.deepEqual(s.coverage, [{ chatId: "c" }]);
		assert.deepEqual(s.checkpoints, [{ chatId: "c" }]);
		assert.deepEqual(s.positions, { n1: { x: 1, y: 2 } });
	});
	it("snapshot is not aliased to live arrays", () => {
		const { s, port } = store();
		const snap = snapshotLedgers(port);
		(s.nodes as Array<{ id: string }>).push({ id: "n2" });
		assert.equal(snap.nodes.length, 1);
	});
});
```

Run (expect FAIL), then implement `src/core/ledger-snapshot.ts`:

```ts
/** Verbatim capture/restore of the five rewritable graph ledgers (undo). */
import type { LedgerSnapshot } from "./contracts/cli.ts";
import type { GraphStore } from "./ports.ts";

export function snapshotLedgers(store: GraphStore): LedgerSnapshot {
	return structuredClone({
		nodes: store.readNodes(),
		chains: store.readChains(),
		coverage: store.readCoverage(),
		checkpoints: store.readCheckpoints(),
		positions: store.readPositions(),
	});
}

export function restoreLedgers(store: GraphStore, snap: LedgerSnapshot): void {
	store.rewriteLedgers({ nodes: snap.nodes, chains: snap.chains, coverage: snap.coverage, checkpoints: snap.checkpoints });
	store.writePositions(snap.positions);
}
```
Run `NODE_ENV=test npx tsx --test tests/ledger-snapshot.test.ts` → pass.

- [ ] **Step 3: Write failing store tests**

`tests/cli-stores.test.ts`:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createCliChatStore } from "../src/store/cli-chats.ts";
import { createCliStateStore } from "../src/store/cli-state.ts";
import { newCliMessage } from "../src/core/cli-chat.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-store-"));

describe("cli chat store", () => {
	it("create → get → list → save → rename → delete", () => {
		const store = createCliChatStore(tmp());
		const chat = store.create();
		assert.equal(chat.title, "New CLI chat");
		assert.deepEqual(store.get(chat.id)?.messages, []);
		const msgs = [newCliMessage("user", "m1", "2026-10-27T00:00:00.000Z", "hi")];
		const saved = store.save(chat.id, { messages: msgs, cliSessionId: "sess-1" });
		assert.equal(saved.cliSessionId, "sess-1");
		assert.equal(store.list()[0]!.messageCount, 1);
		assert.equal(store.rename(chat.id, "  FINA 411 cleanup ").title, "FINA 411 cleanup");
		assert.equal(store.delete(chat.id), true);
		assert.equal(store.get(chat.id), null);
		assert.equal(store.delete(chat.id), false);
	});
	it("list is newest-activity first; rename does not reorder", () => {
		const store = createCliChatStore(tmp());
		const a = store.create("A");
		const b = store.create("B");
		store.save(a.id, { messages: [newCliMessage("user", "m", "2026-10-27T00:00:00.000Z", "x")] });
		assert.deepEqual(store.list().map((c) => c.title), ["A", "B"]);
		const before = store.list().map((c) => c.updatedAt);
		store.rename(b.id, "B2");
		assert.deepEqual(store.list().map((c) => c.updatedAt), before);
	});
	it("rejects path-like ids and returns null for unknown / corrupt files", () => {
		const dir = tmp();
		const store = createCliChatStore(dir);
		assert.throws(() => store.get("../x"));
		fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
		assert.equal(store.get("bad"), null);
		assert.equal(store.get("missing"), null);
	});
	it("rename of an unknown chat throws", () => {
		assert.throws(() => createCliChatStore(tmp()).rename("nope", "x"));
	});
});

describe("cli state store", () => {
	it("usage and undo round-trip; clearUndo removes", () => {
		const store = createCliStateStore(tmp());
		assert.equal(store.readUsage(), null);
		const usage = { fiveHour: { utilization: 0.1, resetsAt: 1, status: "allowed" }, sevenDay: null, capturedAt: "t" };
		store.writeUsage(usage);
		assert.deepEqual(store.readUsage(), usage);
		assert.equal(store.readUndo(), null);
		const undo = { id: "u", label: "l", at: "t", revisionAfter: 5, ledgers: { nodes: [], chains: [], coverage: [], checkpoints: [], positions: {} } };
		store.writeUndo(undo);
		assert.deepEqual(store.readUndo(), undo);
		store.clearUndo();
		assert.equal(store.readUndo(), null);
	});
	it("a corrupt file reads as null", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "usage.json"), "{x");
		assert.equal(createCliStateStore(dir).readUsage(), null);
	});
});
```
Run → FAIL (modules missing).

- [ ] **Step 4: Implement the stores**

`src/store/cli-chats.ts`:

```ts
/**
 * CliChatStore — fs JSON adapter (one file per Claude CLI chat). Same idioms
 * as store/chats.ts: sync fs, tab-indented JSON, id-guarded filenames. Writes
 * go through a temp file + rename so a torn write never replaces a record.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CLI_TITLE, type CliChatRecord, type CliChatSummary } from "../core/contracts/cli.ts";
import type { CliChatStore } from "../core/ports.ts";

export function createCliChatStore(dir: string): CliChatStore {
	const fileOf = (id: string): string => {
		if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid CLI chat id: ${id}`);
		return path.join(dir, `${id}.json`);
	};
	const write = (record: CliChatRecord): void => {
		fs.mkdirSync(dir, { recursive: true });
		const file = fileOf(record.id);
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(record, null, "\t"), "utf-8");
		fs.renameSync(tmp, file);
	};
	const read = (id: string): CliChatRecord | null => {
		try {
			const parsed = JSON.parse(fs.readFileSync(fileOf(id), "utf-8")) as CliChatRecord;
			return typeof parsed.id === "string" && Array.isArray(parsed.messages) ? parsed : null;
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("Invalid CLI chat id")) throw err;
			return null;
		}
	};
	const need = (id: string): CliChatRecord => {
		const rec = read(id);
		if (rec === null) throw new Error(`Unknown CLI chat: ${id}`);
		return rec;
	};
	return {
		create(title) {
			const now = new Date().toISOString();
			const record: CliChatRecord = {
				id: `cli_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
				title: title?.trim() || DEFAULT_CLI_TITLE,
				createdAt: now,
				updatedAt: now,
				messages: [],
			};
			write(record);
			return record;
		},
		get: read,
		list() {
			let names: string[];
			try { names = fs.readdirSync(dir); } catch { return []; }
			const out: CliChatSummary[] = [];
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const rec = read(name.slice(0, -5));
				if (rec) out.push({ id: rec.id, title: rec.title, createdAt: rec.createdAt, updatedAt: rec.updatedAt, messageCount: rec.messages.length });
			}
			return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		save(id, patch) {
			const rec = need(id);
			const next: CliChatRecord = {
				...rec,
				...(patch.messages ? { messages: patch.messages, updatedAt: new Date().toISOString() } : {}),
				...(patch.cliSessionId ? { cliSessionId: patch.cliSessionId } : {}),
			};
			write(next);
			return next;
		},
		rename(id, title) {
			const trimmed = title.trim();
			if (trimmed === "") throw new Error("title must be non-empty");
			const next = { ...need(id), title: trimmed }; // a rename is not activity: updatedAt stays
			write(next);
			return next;
		},
		delete(id) {
			try { fs.unlinkSync(fileOf(id)); return true; } catch (err) {
				if (err instanceof Error && err.message.startsWith("Invalid CLI chat id")) throw err;
				return false;
			}
		},
	};
}
```

`src/store/cli-state.ts`:

```ts
/** CliStateStore — two single-record JSON files: the latest plan-limit snapshot and the latest undo point. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { UndoRecord, UsageSnapshot } from "../core/contracts/cli.ts";
import type { CliStateStore } from "../core/ports.ts";

export function createCliStateStore(dir: string): CliStateStore {
	const usageFile = path.join(dir, "usage.json");
	const undoFile = path.join(dir, "undo.json");
	const readJson = <T>(file: string): T | null => {
		try { return JSON.parse(fs.readFileSync(file, "utf-8")) as T; } catch { return null; }
	};
	const writeJson = (file: string, value: unknown): void => {
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(value), "utf-8");
		fs.renameSync(tmp, file);
	};
	return {
		readUsage: () => readJson<UsageSnapshot>(usageFile),
		writeUsage: (s) => writeJson(usageFile, s),
		readUndo: () => readJson<UndoRecord>(undoFile),
		writeUndo: (r) => writeJson(undoFile, r),
		clearUndo: () => { try { fs.unlinkSync(undoFile); } catch { /* none */ } },
	};
}
```
Run `NODE_ENV=test npx tsx --test tests/cli-stores.test.ts` → pass.

- [ ] **Step 5: Write failing graph-ops test**

`tests/graph-ops.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, Position } from "../src/core/contracts.ts";
import type { UndoRecord } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { createGraphOps } from "../src/server/graph-ops.ts";

const node = (id: string, name: string): GraphNode => ({ id, name, statement: `${name}!`, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [{ chatId: "c1", messageId: id }] });
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({ id, premises, conclusion, createdAt: "2026-01-01T00:00:00.000Z", provenance: [{ chatId: "c1", messageId: id }] });

function setup(opts: { busy?: boolean } = {}) {
	const s = { nodes: [node("n_a", "A"), node("n_b", "B"), node("n_c", "C")], chains: [chain("arg_1", ["n_a"], "n_c")], coverage: [] as never[], checkpoints: [] as never[], positions: {} as Record<string, Position> };
	let revision = 1;
	let undo: UndoRecord | null = null;
	let settled = 0;
	const graphStore = {
		readNodes: () => s.nodes, readChains: () => s.chains, readCoverage: () => s.coverage, readCheckpoints: () => s.checkpoints, readPositions: () => s.positions,
		writePositions: (p: Record<string, Position>) => { s.positions = p; revision++; },
		rewriteLedgers: (n: Partial<typeof s>) => { Object.assign(s, n); revision++; },
	} as unknown as GraphStore;
	const ops = createGraphOps({
		graphStore,
		state: { readUndo: () => undo, writeUndo: (r) => { undo = r; }, clearUndo: () => { undo = null; } },
		extractionBusy: () => opts.busy === true,
		revision: () => revision,
		settle: () => { settled++; },
		now: () => new Date("2026-10-27T00:00:00.000Z"),
	});
	return { s, ops, bump: () => { revision++; }, getUndo: () => undo, settled: () => settled };
}

describe("graph ops", () => {
	it("merge settles layout, records an undo point, and undo restores the ledgers", () => {
		const t = setup();
		const r = ops_merge(t);
		assert.ok(r.ok);
		assert.equal(t.settled(), 1);
		assert.deepEqual(t.s.nodes.map((n) => n.id).sort(), ["n_c", (r as { ok: true; value: { newId: string } }).value.newId].sort());
		assert.ok(t.ops.undoInfo());
		const u = t.ops.undo();
		assert.ok(u.ok);
		assert.deepEqual(t.s.nodes.map((n) => n.id).sort(), ["n_a", "n_b", "n_c"]);
		assert.equal(t.ops.undoInfo(), null);
	});
	it("delete_nodes deletes found ids, reports missing, one undo point for the batch", () => {
		const t = setup();
		const r = t.ops.deleteNodes(["n_a", "n_zzz"]);
		assert.ok(r.ok && r.value.deleted.join() === "n_a" && r.value.missing.join() === "n_zzz" && r.value.chainsRemoved === 1);
		assert.deepEqual(t.s.nodes.map((n) => n.id), ["n_b", "n_c"]);
		assert.ok(t.ops.undoInfo());
	});
	it("refuses while an extraction runs and writes nothing", () => {
		const t = setup({ busy: true });
		const r = ops_merge(t);
		assert.deepEqual(r.ok ? null : r.code, "extraction_running");
		assert.equal(t.s.nodes.length, 3);
		assert.equal(t.ops.deleteNodes(["n_a"]).ok, false);
	});
	it("undo is refused when the graph changed after the recorded revision", () => {
		const t = setup();
		ops_merge(t);
		t.bump();
		const u = t.ops.undo();
		assert.equal(u.ok ? null : u.code, "stale");
	});
	it("undo with no record", () => {
		const u = setup().ops.undo();
		assert.equal(u.ok ? null : u.code, "nothing_to_undo");
	});
	it("a rejected merge leaves no undo point", () => {
		const t = setup();
		const r = t.ops.mergeNodes({ ids: ["n_a"], name: "x", statement: "y" });
		assert.equal(r.ok, false);
		assert.equal(t.getUndo(), null);
	});
});

function ops_merge(t: ReturnType<typeof setup>) {
	return t.ops.mergeNodes({ ids: ["n_a", "n_b"], name: "AB", statement: "A and B" });
}
```
Run → FAIL (module missing).

- [ ] **Step 6: Implement `src/server/graph-ops.ts`**

```ts
/**
 * Gated graph mutations for the Claude CLI tools: ONE extraction gate (409
 * semantics, same reasoning as server/graph.ts deleteGraphNode), ONE
 * snapshot per call, ONE undo point. Pure orchestration over injected deps
 * so tests need no fs; src/server/cli.ts wires the real ones.
 */
import { randomUUID } from "node:crypto";
import type { CliOpResult } from "../core/contracts/cli.ts";
import type { GraphStore, CliStateStore } from "../core/ports.ts";
import { deleteNodeTraces } from "../core/graph-deletion.ts";
import { mergeNodes, type MergeInput, type MergeStats } from "../core/graph-merge.ts";
import { restoreLedgers, snapshotLedgers } from "../core/ledger-snapshot.ts";

export interface GraphOpsDeps {
	graphStore: GraphStore;
	state: Pick<CliStateStore, "readUndo" | "writeUndo" | "clearUndo">;
	extractionBusy(): boolean;
	/** graphRevision(): moves on any graph write. */
	revision(): number;
	/** settleGraphLayout(graphStore) — absorbs new nodes into the layout. */
	settle(): void;
	now?(): Date;
}

const BUSY = { ok: false as const, code: "extraction_running", error: "An extraction is running — try again when it finishes" };

export function createGraphOps(d: GraphOpsDeps) {
	const now = () => (d.now ?? (() => new Date()))();

	/** Snapshot → run → (if it changed anything) settle + record the undo point. */
	function withUndo<T>(label: string, run: () => CliOpResult<T>, changed: (v: T) => boolean): CliOpResult<T> {
		if (d.extractionBusy()) return BUSY;
		const before = snapshotLedgers(d.graphStore);
		const result = run();
		if (!result.ok || !changed(result.value)) return result;
		d.settle();
		d.state.writeUndo({ id: randomUUID(), label, at: now().toISOString(), revisionAfter: d.revision(), ledgers: before });
		return result;
	}

	return {
		mergeNodes(input: MergeInput): CliOpResult<{ newId: string } & MergeStats> {
			return withUndo(`Merged ${new Set(input.ids).size} nodes into "${input.name.trim()}"`, () => mergeNodes(d.graphStore, input), () => true);
		},

		deleteNodes(ids: string[]): CliOpResult<{ deleted: string[]; missing: string[]; chainsRemoved: number }> {
			const unique = [...new Set(ids)];
			return withUndo(
				`Deleted ${unique.length} node${unique.length === 1 ? "" : "s"}`,
				() => {
					const deleted: string[] = [];
					const missing: string[] = [];
					let chainsRemoved = 0;
					for (const id of unique) {
						const stats = deleteNodeTraces(d.graphStore, id);
						if (stats === null) missing.push(id);
						else { deleted.push(id); chainsRemoved += stats.chainsRemoved; }
					}
					return { ok: true, value: { deleted, missing, chainsRemoved } };
				},
				(v) => v.deleted.length > 0,
			);
		},

		undoInfo(): { label: string; at: string } | null {
			const rec = d.state.readUndo();
			return rec && rec.revisionAfter === d.revision() ? { label: rec.label, at: rec.at } : null;
		},

		undo(): CliOpResult<{ label: string }> {
			if (d.extractionBusy()) return BUSY;
			const rec = d.state.readUndo();
			if (rec === null) return { ok: false, code: "nothing_to_undo", error: "There is nothing to undo" };
			if (rec.revisionAfter !== d.revision()) {
				return { ok: false, code: "stale", error: "The graph changed since that action, so it can no longer be undone safely" };
			}
			restoreLedgers(d.graphStore, rec.ledgers);
			d.state.clearUndo();
			return { ok: true, value: { label: rec.label } };
		},
	};
}
```

- [ ] **Step 7: Run tests, typecheck, lint, commit**

```bash
NODE_ENV=test npx tsx --test tests/ledger-snapshot.test.ts tests/cli-stores.test.ts tests/graph-ops.test.ts
npm run typecheck && npm run lint
git add src tests
git commit -m "feat(cli): ledger snapshots, CLI stores, and gated graph ops with undo

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: all pass. Note on the undo-valid test "stale": `bump()` increments the fake revision, simulating another writer.

---

### Task 5: CLI stream mapper, argv, and runner

**Files:**
- Create: `src/agent/cli/stream-map.ts`, `src/agent/cli/args.ts`, `src/agent/cli/runner.ts`
- Test: `tests/cli-stream-map.test.ts`, `tests/cli-runner.test.ts`

**Interfaces:**
- Consumes: Task 1 fixture shapes (`tests/fixtures/cli/tool-run.jsonl`), `parseRateLimitEvent`.
- Produces:
  - `createStreamMapper(now?: () => Date): { push(line: unknown): CliRunEvent[] }` and `type CliRunEvent = CliWireEvent | { type: "session"; id: string }`; tool names have the `mcp__lh__` prefix stripped.
  - `buildCliArgs(o: { mcpConfigPath: string; systemPromptPath: string; toolNames: string[]; resume?: string }): string[]`; `CLI_SYSTEM_PROMPT: string`; `MCP_SERVER_NAME = "lh"`.
  - `runCliTurn(o: RunCliTurnOptions): AsyncGenerator<CliRunEvent>`; `interface CliProc { lines: AsyncIterable<string>; stderr(): string; kill(): void; exit: Promise<number | null>; writeStdin(text: string): void }`; `type SpawnProc = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => CliProc`; `spawnProc: SpawnProc` (real). `RunCliTurnOptions = { prompt: string; resume?: string; mcpUrl: string; workDir: string; toolNames: string[]; signal?: AbortSignal; bin?: string; spawnProc?: SpawnProc; tmpRoot?: string; now?: () => Date }`.

- [ ] **Step 1: Write failing mapper tests**

`tests/cli-stream-map.test.ts` (shapes confirmed in Task 1; adjust field names here if the recorded fixture differed):

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { createStreamMapper } from "../src/agent/cli/stream-map.ts";

const now = () => new Date("2026-10-27T12:00:00.000Z");
const run = (lines: unknown[]) => { const m = createStreamMapper(now); return lines.flatMap((l) => m.push(l)); };

const delta = (messageId: string, text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, api_message_id: messageId });
const start = (messageId: string) => ({ type: "stream_event", event: { type: "message_start", message: { id: messageId } } });

describe("stream mapper", () => {
	it("emits the session id once, from the first line that has one", () => {
		const ev = run([{ type: "system", subtype: "init", session_id: "s1" }, { type: "system", subtype: "status", session_id: "s1" }]);
		assert.deepEqual(ev, [{ type: "session", id: "s1" }]);
	});
	it("streams text deltas and does NOT repeat the full assistant text for a streamed message", () => {
		const ev = run([
			start("m1"), delta("m1", "Hel"), delta("m1", "lo"),
			{ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hello" }] } },
		]);
		assert.deepEqual(ev, [{ type: "text", delta: "Hel" }, { type: "text", delta: "lo" }]);
	});
	it("emits full assistant text when that message never streamed", () => {
		const ev = run([{ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Whole" }] } }]);
		assert.deepEqual(ev, [{ type: "text", delta: "Whole" }]);
	});
	it("maps tool_use to tool-start (prefix stripped) and tool_result to tool-end", () => {
		const ev = run([
			{ type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "t1", name: "mcp__lh__list_nodes", input: { limit: 5 } }] } },
			{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "3 nodes" }], is_error: false }] } },
		]);
		assert.deepEqual(ev, [
			{ type: "tool-start", id: "t1", name: "list_nodes", input: { limit: 5 } },
			{ type: "tool-end", id: "t1", output: "3 nodes", isError: false },
		]);
	});
	it("tool_result content may be a plain string; is_error maps through", () => {
		const ev = run([{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "nope", is_error: true }] } }]);
		assert.deepEqual(ev, [{ type: "tool-end", id: "t9", output: "nope", isError: true }]);
	});
	it("rate_limit_event becomes a usage event", () => {
		const ev = run([{ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 9, status: "allowed" } } } }]);
		assert.equal(ev[0]!.type, "usage");
		assert.equal((ev[0] as { usage: { capturedAt: string } }).usage.capturedAt, "2026-10-27T12:00:00.000Z");
	});
	it("an error result becomes an error event; a clean result emits nothing", () => {
		assert.deepEqual(run([{ type: "result", is_error: true, result: "Invalid API key · Please run /login" }]), [{ type: "error", message: "Invalid API key · Please run /login" }]);
		assert.deepEqual(run([{ type: "result", is_error: false, result: "ok" }]), []);
	});
	it("ignores hooks, status, junk", () => {
		assert.deepEqual(run([{ type: "system", subtype: "hook_started" }, "junk", null, 5]), []);
	});
	it("replays the recorded real run into text/tool events without throwing", () => {
		const lines = fs.readFileSync("tests/fixtures/cli/tool-run.jsonl", "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown);
		const ev = run(lines);
		assert.ok(ev.some((e) => e.type === "tool-start" && e.name === "ping_lh"));
		assert.ok(ev.some((e) => e.type === "tool-end"));
		assert.ok(ev.some((e) => e.type === "session"));
	});
});
```
Run → FAIL (module missing).

- [ ] **Step 2: Implement the mapper**

`src/agent/cli/stream-map.ts`:

```ts
/**
 * Claude CLI stream-json → the app's wire vocabulary. With
 * --include-partial-messages the text arrives as stream_event deltas AND again
 * inside the final `assistant` message, so text is taken from deltas for any
 * message that streamed and from the `assistant` line only otherwise. Tool
 * calls come from `assistant` tool_use blocks, results from `user` tool_result
 * blocks. Unknown lines are ignored: the CLI protocol is an adapter concern
 * and must never crash a turn.
 */
import { MCP_SERVER_NAME } from "./args.ts";
import { parseRateLimitEvent } from "../../core/cli-usage.ts";
import type { CliWireEvent } from "../../core/contracts/cli.ts";

export type CliRunEvent = CliWireEvent | { type: "session"; id: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
	}
	return "";
}

export function createStreamMapper(now: () => Date = () => new Date()) {
	let sessionSent = false;
	const streamed = new Set<string>();

	function push(line: unknown): CliRunEvent[] {
		if (!isRecord(line)) return [];
		const out: CliRunEvent[] = [];

		if (!sessionSent && typeof line.session_id === "string") {
			sessionSent = true;
			out.push({ type: "session", id: line.session_id });
		}

		switch (line.type) {
			case "stream_event": {
				const ev = line.event;
				if (!isRecord(ev)) break;
				if (ev.type === "message_start" && isRecord(ev.message) && typeof ev.message.id === "string") streamed.add(ev.message.id);
				if (ev.type === "content_block_delta" && isRecord(ev.delta) && ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
					out.push({ type: "text", delta: ev.delta.text });
				}
				break;
			}
			case "assistant": {
				const msg = line.message;
				if (!isRecord(msg) || !Array.isArray(msg.content)) break;
				const wasStreamed = typeof msg.id === "string" && streamed.has(msg.id);
				for (const block of msg.content) {
					if (!isRecord(block)) continue;
					if (block.type === "text" && typeof block.text === "string" && !wasStreamed) out.push({ type: "text", delta: block.text });
					if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
						out.push({ type: "tool-start", id: block.id, name: block.name.startsWith(PREFIX) ? block.name.slice(PREFIX.length) : block.name, input: block.input });
					}
				}
				break;
			}
			case "user": {
				const msg = line.message;
				if (!isRecord(msg) || !Array.isArray(msg.content)) break;
				for (const block of msg.content) {
					if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
						out.push({ type: "tool-end", id: block.tool_use_id, output: resultText(block.content), isError: block.is_error === true });
					}
				}
				break;
			}
			case "rate_limit_event": {
				const usage = parseRateLimitEvent(line, now());
				if (usage) out.push({ type: "usage", usage });
				break;
			}
			case "result": {
				if (line.is_error === true) out.push({ type: "error", message: typeof line.result === "string" && line.result !== "" ? line.result : "The Claude CLI reported an error" });
				break;
			}
		}
		return out;
	}
	return { push };
}
```

- [ ] **Step 3: Write failing args + runner tests**

`tests/cli-runner.test.ts`:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { buildCliArgs } from "../src/agent/cli/args.ts";
import { runCliTurn, type CliProc, type SpawnProc } from "../src/agent/cli/runner.ts";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const x of it) out.push(x); return out; }

function fakeProc(lines: unknown[], exitCode = 0, stderr = ""): { spawn: SpawnProc; seen: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; stdin: string; cfg: string; killed: boolean } } {
	const seen = { args: [] as string[], env: {} as NodeJS.ProcessEnv, cwd: "", stdin: "", cfg: "", killed: false };
	const spawn: SpawnProc = (_bin, args, opts) => {
		seen.args = args; seen.env = opts.env; seen.cwd = opts.cwd;
		seen.cfg = fs.readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf-8");
		const proc: CliProc = {
			lines: (async function* () { for (const l of lines) yield typeof l === "string" ? l : JSON.stringify(l); })(),
			stderr: () => stderr, kill: () => { seen.killed = true; }, exit: Promise.resolve(exitCode), writeStdin: (t) => { seen.stdin += t; },
		};
		return proc;
	};
	return { spawn, seen };
}
const base = { prompt: "merge my nodes", mcpUrl: "http://127.0.0.1:3000/api/cli/mcp/tok", workDir: "/tmp/lh-work", toolNames: ["list_nodes", "merge_nodes"] };

describe("buildCliArgs", () => {
	it("is hardened, joins allowed tools into ONE comma value, and resumes only when asked", () => {
		const a = buildCliArgs({ mcpConfigPath: "m.json", systemPromptPath: "s.md", toolNames: ["list_nodes", "merge_nodes"] });
		assert.deepEqual(a.slice(0, 5), ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
		assert.ok(a.includes("--strict-mcp-config") && a.includes("--disable-slash-commands"));
		assert.equal(a[a.indexOf("--tools") + 1], "");
		assert.equal(a[a.indexOf("--setting-sources") + 1], "");
		assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__lh__list_nodes,mcp__lh__merge_nodes");
		assert.ok(!a.includes("--resume"));
		assert.deepEqual(buildCliArgs({ mcpConfigPath: "m.json", systemPromptPath: "s.md", toolNames: [], resume: "sess" }).slice(-2), ["--resume", "sess"]);
	});
});

describe("runCliTurn", () => {
	it("writes the MCP config, pipes the prompt on stdin, strips ANTHROPIC_API_KEY, sets the tool timeout, maps events", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
		const { spawn, seen } = fakeProc([
			{ type: "system", subtype: "init", session_id: "s1" },
			{ type: "assistant", message: { id: "m", content: [{ type: "text", text: "done" }] } },
			{ type: "result", is_error: false, result: "done" },
		]);
		const events = await collect(runCliTurn({ ...base, spawnProc: spawn }));
		assert.deepEqual(events, [{ type: "session", id: "s1" }, { type: "text", delta: "done" }]);
		assert.equal(seen.stdin, "merge my nodes");
		assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(seen.env.MCP_TOOL_TIMEOUT, "600000");
		assert.equal(seen.cwd, "/tmp/lh-work");
		assert.deepEqual(JSON.parse(seen.cfg), { mcpServers: { lh: { type: "http", url: base.mcpUrl } } });
		delete process.env.ANTHROPIC_API_KEY;
	});
	it("passes --resume when given a session id", async () => {
		const { spawn, seen } = fakeProc([]);
		await collect(runCliTurn({ ...base, resume: "old-sess", spawnProc: spawn }));
		assert.equal(seen.args[seen.args.indexOf("--resume") + 1], "old-sess");
	});
	it("skips non-JSON lines", async () => {
		const { spawn } = fakeProc(["not json", { type: "assistant", message: { id: "m", content: [{ type: "text", text: "ok" }] } }]);
		assert.deepEqual(await collect(runCliTurn({ ...base, spawnProc: spawn })), [{ type: "text", delta: "ok" }]);
	});
	it("a non-zero exit with no error result becomes an error event carrying the stderr tail", async () => {
		const { spawn } = fakeProc([], 1, "boom\n");
		const events = await collect(runCliTurn({ ...base, spawnProc: spawn }));
		assert.equal(events.length, 1);
		assert.equal(events[0]!.type, "error");
		assert.match((events[0] as { message: string }).message, /exited with code 1.*boom/s);
	});
	it("a missing binary becomes the setup message", async () => {
		const { spawn } = fakeProc([], -1, "Error: spawn claude ENOENT");
		const events = await collect(runCliTurn({ ...base, spawnProc: spawn }));
		assert.match((events[0] as { message: string }).message, /Claude CLI not found/);
	});
	it("kills the child when the signal aborts", async () => {
		const { spawn, seen } = fakeProc([{ type: "system", session_id: "s" }]);
		const ac = new AbortController();
		ac.abort();
		await collect(runCliTurn({ ...base, spawnProc: spawn, signal: ac.signal }));
		assert.equal(seen.killed, true);
	});
});
```
Run → FAIL (modules missing).

- [ ] **Step 4: Implement `args.ts`**

```ts
/**
 * The hardened argv for a Claude CLI turn. Measured on the dev machine: the
 * default `claude -p` loads user plugins/MCP/hooks (405,260 cache tokens,
 * $1.62 for "say hi"); these flags cut a turn to ~883 tokens, which matters
 * twice here — it is the learner's subscription we are spending. Allowed
 * tools are ONE comma-joined value because --allowedTools is variadic and
 * would swallow following flags.
 */
export const MCP_SERVER_NAME = "lh";

export function buildCliArgs(o: { mcpConfigPath: string; systemPromptPath: string; toolNames: string[]; resume?: string }): string[] {
	return [
		"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--tools", "",
		"--strict-mcp-config", "--mcp-config", o.mcpConfigPath,
		"--allowedTools", o.toolNames.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`).join(","),
		"--setting-sources", "",
		"--disable-slash-commands",
		"--system-prompt-file", o.systemPromptPath,
		...(o.resume ? ["--resume", o.resume] : []),
	];
}

export const CLI_SYSTEM_PROMPT = `You are the Claude assistant inside the Learning Harness desktop app. You help the learner manage their knowledge-graph nodes and their chat sessions, using ONLY the provided tools.

How the graph works:
- A node is one minimal proposition: a short name plus one precise statement. Reasoning chains link propositions (premises jointly entail a conclusion).
- Merging replaces several nodes with ONE node whose name and statement you supply; all old wording survives as aliases and all chains are re-pointed. A chain whose premise and conclusion both become the merged node is dropped.

Rules:
- Look before you act: search/list/get first, and state the ids and counts you will touch.
- Default to merging nodes that say the SAME thing and keeping distinct ideas separate, so the graph stays connected.
- Collapse a whole course or topic into one node ONLY when the learner explicitly asks. When you do, say how many chains will be dropped.
- Deleting or merging shows the learner an approval card; if they reject it, accept that and do not retry the same action.
- Chat deletion cannot be undone. Node merges and node deletions can be undone from the chat.
- Be concise.`;
```

- [ ] **Step 5: Implement `runner.ts`**

```ts
/**
 * Spawns one Claude CLI turn and yields the app's run events. The process
 * boundary is injectable (SpawnProc) so tests drive recorded lines through
 * the real mapper with no CLI installed. Deliberately NOT inheriting
 * ANTHROPIC_API_KEY: with it set the CLI bills the API instead of the
 * learner's subscription, which defeats the plan-limit meter.
 */
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { buildCliArgs, CLI_SYSTEM_PROMPT, MCP_SERVER_NAME } from "./args.ts";
import { createStreamMapper, type CliRunEvent } from "./stream-map.ts";

export interface CliProc {
	lines: AsyncIterable<string>;
	stderr(): string;
	kill(): void;
	exit: Promise<number | null>;
	writeStdin(text: string): void;
}
export type SpawnProc = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => CliProc;

export const spawnProc: SpawnProc = (bin, args, opts) => {
	const child = nodeSpawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
	let err = "";
	child.stderr.on("data", (d: Buffer) => { err += String(d); });
	const exit = new Promise<number | null>((resolve) => {
		child.on("error", (e) => { err += String(e); resolve(-1); });
		child.on("close", (code) => resolve(code));
	});
	return {
		lines: createInterface({ input: child.stdout }),
		stderr: () => err,
		kill: () => { child.kill(); },
		exit,
		writeStdin: (text) => { child.stdin.end(text); },
	};
};

export interface RunCliTurnOptions {
	prompt: string;
	resume?: string;
	mcpUrl: string;
	workDir: string;
	toolNames: string[];
	signal?: AbortSignal;
	bin?: string;
	spawnProc?: SpawnProc;
	tmpRoot?: string;
	now?: () => Date;
}

const NOT_FOUND = "Claude CLI not found. Install it from https://claude.com/claude-code, run `claude` once to sign in, then try again.";

export async function* runCliTurn(o: RunCliTurnOptions): AsyncGenerator<CliRunEvent> {
	fs.mkdirSync(o.workDir, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(o.tmpRoot ?? os.tmpdir(), "lh-cli-"));
	try {
		const mcpConfigPath = path.join(tmp, "mcp.json");
		const systemPromptPath = path.join(tmp, "system.md");
		fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: o.mcpUrl } } }));
		fs.writeFileSync(systemPromptPath, CLI_SYSTEM_PROMPT);

		const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: "600000" };
		delete env.ANTHROPIC_API_KEY;

		const proc = (o.spawnProc ?? spawnProc)(o.bin ?? process.env.LH_CLAUDE_BIN ?? "claude", buildCliArgs({ mcpConfigPath, systemPromptPath, toolNames: o.toolNames, resume: o.resume }), { cwd: o.workDir, env });
		const onAbort = () => proc.kill();
		if (o.signal?.aborted) onAbort();
		else o.signal?.addEventListener("abort", onAbort, { once: true });
		proc.writeStdin(o.prompt);

		const mapper = createStreamMapper(o.now);
		let sawError = false;
		for await (const raw of proc.lines) {
			let parsed: unknown;
			try { parsed = JSON.parse(raw); } catch { continue; }
			for (const ev of mapper.push(parsed)) {
				if (ev.type === "error") sawError = true;
				yield ev;
			}
		}
		const code = await proc.exit;
		o.signal?.removeEventListener("abort", onAbort);
		if (code !== 0 && !sawError && !o.signal?.aborted) {
			const err = proc.stderr();
			yield { type: "error", message: /ENOENT|not recognized|not found/i.test(err) && code === -1 ? NOT_FOUND : `Claude CLI exited with code ${code}: ${err.trim().split("\n").slice(-5).join("\n")}` };
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
```

- [ ] **Step 6: Run tests, typecheck, lint, commit**

```bash
NODE_ENV=test npx tsx --test tests/cli-stream-map.test.ts tests/cli-runner.test.ts
npm run typecheck && npm run lint
git add src/agent/cli tests/cli-stream-map.test.ts tests/cli-runner.test.ts
git commit -m "feat(cli): stream mapper, hardened argv, and turn runner

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: pass. If the fixture-replay test fails, the recorded real shapes differ from Task 1's assumptions — fix the mapper to match the fixture (the fixture is the truth).

---

### Task 6: MCP JSON-RPC handler and the nine tools

**Files:**
- Create: `src/agent/cli/mcp-rpc.ts`, `src/agent/cli/tools.ts`
- Test: `tests/cli-mcp-rpc.test.ts`, `tests/cli-tools.test.ts`

**Interfaces:**
- Consumes: Task 2 types, Task 3 `MergeInput`/`MergePreview`/`MergeStats` types (type-only imports from `../../core/graph-merge.ts`).
- Produces:
  - `interface CliToolResult { text: string; isError?: boolean }`; `interface CliTool { name: string; description: string; inputSchema: Record<string, unknown>; run(args: Record<string, unknown>): Promise<CliToolResult> }`; `handleMcpMessage(msg: unknown, tools: CliTool[]): Promise<Record<string, unknown> | null>` (null = notification, reply 202).
  - `interface CliToolDeps { graph(): { nodes: GraphNode[]; chains: GraphChain[] }; chats(): ChatSummary[]; chatTitles(): Record<string, string>; renameChat(id: string, title: string): CliOpResult<null>; previewMerge(ids: string[]): MergePreview; mergeNodes(input: MergeInput): CliOpResult<{ newId: string } & MergeStats>; deleteNodes(ids: string[]): CliOpResult<{ deleted: string[]; missing: string[]; chainsRemoved: number }>; deleteChats(ids: string[], mode: "preserve-graph" | "delete-nodes"): Promise<Array<{ id: string; ok: boolean; message: string }>>; requestApproval(req: CliApprovalRequest): Promise<CliApprovalDecision> }`; `createCliTools(deps: CliToolDeps): CliTool[]`; `CLI_TOOL_NAMES: string[]` (the nine names).

- [ ] **Step 1: Write failing RPC tests**

`tests/cli-mcp-rpc.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleMcpMessage, type CliTool } from "../src/agent/cli/mcp-rpc.ts";

const tools: CliTool[] = [
	{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { s: { type: "string" } } }, run: async (a) => ({ text: `got ${String(a.s)}` }) },
	{ name: "boom", description: "Fails", inputSchema: { type: "object" }, run: async () => { throw new Error("kaboom"); } },
	{ name: "soft", description: "Soft fail", inputSchema: { type: "object" }, run: async () => ({ text: "refused", isError: true }) },
];
const call = (method: string, params?: unknown, id: number | undefined = 1) => handleMcpMessage({ jsonrpc: "2.0", id, method, params }, tools);

describe("handleMcpMessage", () => {
	it("initialize echoes the client's protocol version and advertises tools", async () => {
		const r = await call("initialize", { protocolVersion: "2025-06-18" });
		assert.deepEqual(r, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "learnharness", version: "1" } } });
	});
	it("notifications (no id) return null", async () => {
		assert.equal(await call("notifications/initialized", undefined, undefined), null);
	});
	it("tools/list returns name, description, inputSchema", async () => {
		const r = (await call("tools/list")) as { result: { tools: Array<{ name: string }> } };
		assert.deepEqual(r.result.tools.map((t) => t.name), ["echo", "boom", "soft"]);
		assert.ok("inputSchema" in r.result.tools[0]!);
	});
	it("tools/call runs the tool and wraps text content", async () => {
		const r = await call("tools/call", { name: "echo", arguments: { s: "hi" } });
		assert.deepEqual(r, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "got hi" }] } });
	});
	it("a thrown tool error and a soft failure are isError results, not RPC errors", async () => {
		const thrown = (await call("tools/call", { name: "boom", arguments: {} })) as { result: { isError: boolean; content: Array<{ text: string }> } };
		assert.equal(thrown.result.isError, true);
		assert.match(thrown.result.content[0]!.text, /kaboom/);
		const soft = (await call("tools/call", { name: "soft", arguments: {} })) as { result: { isError: boolean } };
		assert.equal(soft.result.isError, true);
	});
	it("unknown tool is an isError result; unknown method is -32601; ping is {}", async () => {
		const unk = (await call("tools/call", { name: "nope" })) as { result: { isError: boolean } };
		assert.equal(unk.result.isError, true);
		assert.deepEqual((await call("bogus")) as object, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found: bogus" } });
		assert.deepEqual(await call("ping"), { jsonrpc: "2.0", id: 1, result: {} });
	});
	it("a non-object or batch body is -32600", async () => {
		const r = (await handleMcpMessage([{}], tools)) as { error: { code: number } };
		assert.equal(r.error.code, -32600);
	});
});
```

- [ ] **Step 2: Implement `mcp-rpc.ts`**

```ts
/**
 * A minimal MCP server over JSON-RPC (Streamable HTTP, single-response
 * mode): initialize, ping, tools/list, tools/call. Hand-rolled on purpose —
 * four methods do not justify a dependency in the desktop bundle. Tool
 * failures are `isError` RESULTS (the model can read and explain them), never
 * JSON-RPC errors.
 */
export interface CliToolResult { text: string; isError?: boolean }
export interface CliTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run(args: Record<string, unknown>): Promise<CliToolResult>;
}

type Reply = Record<string, unknown>;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function handleMcpMessage(msg: unknown, tools: CliTool[]): Promise<Reply | null> {
	if (!isRecord(msg) || typeof msg.method !== "string") {
		return { jsonrpc: "2.0", id: isRecord(msg) && "id" in msg ? msg.id : null, error: { code: -32600, message: "Invalid Request" } };
	}
	if (!("id" in msg) || msg.id === undefined) return null; // notification
	const id = msg.id;
	const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
	const params = isRecord(msg.params) ? msg.params : {};

	switch (msg.method) {
		case "initialize":
			return ok({
				protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "learnharness", version: "1" },
			});
		case "ping":
			return ok({});
		case "tools/list":
			return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
		case "tools/call": {
			const tool = tools.find((t) => t.name === params.name);
			if (!tool) return ok({ isError: true, content: [{ type: "text", text: `Unknown tool: ${String(params.name)}` }] });
			try {
				const r = await tool.run(isRecord(params.arguments) ? params.arguments : {});
				return ok({ ...(r.isError ? { isError: true } : {}), content: [{ type: "text", text: r.text }] });
			} catch (err) {
				return ok({ isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] });
			}
		}
		default:
			return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } };
	}
}
```
Run `NODE_ENV=test npx tsx --test tests/cli-mcp-rpc.test.ts` → pass.

- [ ] **Step 3: Write failing tools tests**

`tests/cli-tools.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CliApprovalDecision, CliApprovalRequest, ChatSummary, GraphChain, GraphNode } from "../src/core/contracts.ts";
import { CLI_TOOL_NAMES, createCliTools, type CliToolDeps } from "../src/agent/cli/tools.ts";

const n = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, name, statement: `${name} statement`, aliases: [], createdAt: "t", provenance: [{ chatId: "c1", messageId: "m" }], ...over });
const nodes = [n("n_a", "Time value of money", { aliases: ["TVM"] }), n("n_b", "Discounting"), n("n_c", "Bond pricing", { provenance: [{ chatId: "c2", messageId: "m" }] })];
const chains: GraphChain[] = [{ id: "arg_1", premises: ["n_a", "n_b"], conclusion: "n_c", createdAt: "t", provenance: [{ chatId: "c1", messageId: "m" }] }];
const chatList: ChatSummary[] = [{ id: "c1", title: "FINA 411 wk1", createdAt: "t", updatedAt: "2026-01-02", kind: "teach", messageCount: 4, phase: "teach", pendingQuestion: false, pendingProblem: false }];

function setup(decision: CliApprovalDecision = { approved: true }) {
	const calls = { approvals: [] as CliApprovalRequest[], merges: [] as unknown[], deletes: [] as string[][], chatDeletes: [] as unknown[], renames: [] as unknown[] };
	const deps: CliToolDeps = {
		graph: () => ({ nodes, chains }),
		chats: () => chatList,
		chatTitles: () => ({ c1: "FINA 411 wk1", c2: "Other" }),
		renameChat: (id, title) => { calls.renames.push([id, title]); return { ok: true, value: null }; },
		previewMerge: (ids) => ({ found: ids.filter((i) => nodes.some((x) => x.id === i)).map((id) => ({ id, name: nodes.find((x) => x.id === id)!.name })), missing: ids.filter((i) => !nodes.some((x) => x.id === i)), chainsRewritten: 1, chainsDropped: 0 }),
		mergeNodes: (input) => { calls.merges.push(input); return { ok: true, value: { newId: "n_new", nodesMerged: input.ids.length, chainsRewritten: 1, chainsDropped: 0 } }; },
		deleteNodes: (ids) => { calls.deletes.push(ids); return { ok: true, value: { deleted: ids, missing: [], chainsRemoved: 1 } }; },
		deleteChats: async (ids, mode) => { calls.chatDeletes.push([ids, mode]); return ids.map((id) => ({ id, ok: true, message: "deleted" })); },
		requestApproval: async (req) => { calls.approvals.push(req); return decision; },
	};
	const tools = new Map(createCliTools(deps).map((t) => [t.name, t]));
	return { tools, calls };
}

describe("cli tools", () => {
	it("exposes exactly the nine documented tools", () => {
		assert.deepEqual([...setup().tools.keys()].sort(), [...CLI_TOOL_NAMES].sort());
		assert.equal(CLI_TOOL_NAMES.length, 9);
	});
	it("list_nodes honors limit/offset and chatId filter", async () => {
		const { tools } = setup();
		const all = await tools.get("list_nodes")!.run({});
		assert.match(all.text, /n_a \| Time value of money/);
		assert.match(all.text, /3 nodes/);
		const byChat = await tools.get("list_nodes")!.run({ chatId: "c2" });
		assert.match(byChat.text, /n_c/);
		assert.doesNotMatch(byChat.text, /n_a/);
		const page = await tools.get("list_nodes")!.run({ limit: 1, offset: 1 });
		assert.match(page.text, /n_b/);
		assert.doesNotMatch(page.text, /n_a/);
	});
	it("search_nodes matches name, statement and aliases case-insensitively", async () => {
		const { tools } = setup();
		assert.match((await tools.get("search_nodes")!.run({ query: "tvm" })).text, /n_a/);
		assert.match((await tools.get("search_nodes")!.run({ query: "BOND" })).text, /n_c/);
		assert.match((await tools.get("search_nodes")!.run({ query: "zzz" })).text, /No nodes match/);
	});
	it("get_node shows statement, aliases, source chats and chains with names", async () => {
		const { tools } = setup();
		const r = await tools.get("get_node")!.run({ id: "n_c" });
		assert.match(r.text, /Bond pricing/);
		assert.match(r.text, /Other/);
		assert.match(r.text, /Time value of money \+ Discounting ⟹ Bond pricing/);
		assert.equal((await tools.get("get_node")!.run({ id: "nope" })).isError, true);
	});
	it("list_chats and get_chat", async () => {
		const { tools } = setup();
		assert.match((await tools.get("list_chats")!.run({})).text, /c1 \| FINA 411 wk1/);
		const g = await tools.get("get_chat")!.run({ id: "c1" });
		assert.match(g.text, /FINA 411 wk1/);
		assert.match(g.text, /2 nodes/);
		assert.equal((await tools.get("get_chat")!.run({ id: "x" })).isError, true);
	});
	it("rename_chat runs immediately with no approval", async () => {
		const { tools, calls } = setup();
		await tools.get("rename_chat")!.run({ id: "c1", title: "Midterm prep" });
		assert.deepEqual(calls.renames, [["c1", "Midterm prep"]]);
		assert.equal(calls.approvals.length, 0);
	});
	it("merge_nodes asks approval with the preview, then merges with the edited identity", async () => {
		const { tools, calls } = setup({ approved: true, edit: { name: "Edited", statement: "Edited statement" } });
		const r = await tools.get("merge_nodes")!.run({ ids: ["n_a", "n_b"], name: "Proposed", statement: "Proposed statement" });
		assert.equal(calls.approvals.length, 1);
		assert.equal(calls.approvals[0]!.tool, "merge_nodes");
		assert.deepEqual(calls.approvals[0]!.edit, { name: "Proposed", statement: "Proposed statement" });
		assert.ok(calls.approvals[0]!.lines.some((l) => l.includes("Chains rewritten: 1")));
		assert.deepEqual(calls.merges, [{ ids: ["n_a", "n_b"], name: "Edited", statement: "Edited statement" }]);
		assert.match(r.text, /Merged 2 nodes into n_new/);
	});
	it("merge_nodes rejected → nothing written, tells the model not to retry", async () => {
		const { tools, calls } = setup({ approved: false });
		const r = await tools.get("merge_nodes")!.run({ ids: ["n_a", "n_b"], name: "P", statement: "S" });
		assert.equal(calls.merges.length, 0);
		assert.equal(r.isError, true);
		assert.match(r.text, /rejected/i);
	});
	it("merge_nodes validates before asking: unknown ids, <2 ids, blank identity", async () => {
		const { tools, calls } = setup();
		for (const args of [{ ids: ["n_a", "n_zzz"], name: "x", statement: "y" }, { ids: ["n_a"], name: "x", statement: "y" }, { ids: ["n_a", "n_b"], name: " ", statement: "y" }]) {
			const r = await tools.get("merge_nodes")!.run(args);
			assert.equal(r.isError, true);
		}
		assert.equal(calls.approvals.length, 0);
	});
	it("delete_nodes lists each node and its chain count in the card, then deletes on approval", async () => {
		const { tools, calls } = setup();
		const r = await tools.get("delete_nodes")!.run({ ids: ["n_a"] });
		assert.ok(calls.approvals[0]!.lines.some((l) => l.includes("Time value of money") && l.includes("1 chain")));
		assert.deepEqual(calls.deletes, [["n_a"]]);
		assert.match(r.text, /Deleted 1 node/);
	});
	it("delete_chats card says it cannot be undone; rejection deletes nothing", async () => {
		const { tools, calls } = setup({ approved: false });
		await tools.get("delete_chats")!.run({ ids: ["c1"], mode: "preserve-graph" });
		assert.ok(calls.approvals[0]!.lines.some((l) => /cannot be undone/i.test(l)));
		assert.equal(calls.chatDeletes.length, 0);
		const bad = await tools.get("delete_chats")!.run({ ids: ["c1"], mode: "bogus" });
		assert.equal(bad.isError, true);
	});
});
```
Run → FAIL (module missing).

- [ ] **Step 4: Implement `tools.ts`**

```ts
/**
 * The nine tools the Claude CLI may call. A factory: every effect (graph
 * reads, merge/delete, chat ops, approval) arrives through CliToolDeps, so
 * this layer never imports server or store (import law) and tests need no fs.
 *
 * Read tools and rename_chat run immediately; delete_nodes, merge_nodes and
 * delete_chats block on requestApproval and write nothing unless approved.
 */
import type { ChatSummary, CliApprovalDecision, CliApprovalRequest, CliOpResult, GraphChain, GraphNode } from "../../core/contracts.ts";
import type { MergeInput, MergePreview, MergeStats } from "../../core/graph-merge.ts";
import type { CliTool, CliToolResult } from "./mcp-rpc.ts";

export interface CliToolDeps {
	graph(): { nodes: GraphNode[]; chains: GraphChain[] };
	chats(): ChatSummary[];
	chatTitles(): Record<string, string>;
	renameChat(id: string, title: string): CliOpResult<null>;
	previewMerge(ids: string[]): MergePreview;
	mergeNodes(input: MergeInput): CliOpResult<{ newId: string } & MergeStats>;
	deleteNodes(ids: string[]): CliOpResult<{ deleted: string[]; missing: string[]; chainsRemoved: number }>;
	deleteChats(ids: string[], mode: "preserve-graph" | "delete-nodes"): Promise<Array<{ id: string; ok: boolean; message: string }>>;
	requestApproval(req: CliApprovalRequest): Promise<CliApprovalDecision>;
}

export const CLI_TOOL_NAMES = ["list_nodes", "search_nodes", "get_node", "list_chats", "get_chat", "rename_chat", "delete_nodes", "merge_nodes", "delete_chats"];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback);
const fail = (text: string): CliToolResult => ({ text, isError: true });
const ok = (text: string): CliToolResult => ({ text });
const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const REJECTED = "The learner rejected this action in the approval card. Nothing was changed. Do not retry the same action; ask what they would like instead.";

export function createCliTools(d: CliToolDeps): CliTool[] {
	const nodeLine = (n: GraphNode) => `${n.id} | ${n.name}`;
	const chainsTouching = (id: string, chains: GraphChain[]) => new Set(chains.filter((c) => c.conclusion === id || c.premises.includes(id)).map((c) => c.id)).size;

	const tools: CliTool[] = [
		{
			name: "list_nodes",
			description: "List knowledge-graph nodes (id | name). Optional: limit (default 100), offset, chatId (only nodes that chat touched).",
			inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" }, chatId: { type: "string" } } },
			async run(a) {
				const chatId = str(a.chatId);
				const all = d.graph().nodes.filter((n) => chatId === "" || n.provenance.some((p) => p.chatId === chatId));
				const limit = num(a.limit, 100);
				const offset = num(a.offset, 0);
				const page = all.slice(offset, offset + limit);
				return ok(`${plural(all.length, "node")}${all.length > page.length ? ` (showing ${page.length} from ${offset})` : ""}\n${page.map(nodeLine).join("\n")}`);
			},
		},
		{
			name: "search_nodes",
			description: "Case-insensitive substring search over node names, statements and aliases. Returns id | name | statement.",
			inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
			async run(a) {
				const q = str(a.query).toLowerCase();
				if (q === "") return fail("query is required");
				const hits = d.graph().nodes.filter((n) => [n.name, n.statement, ...n.aliases].some((s) => s.toLowerCase().includes(q)));
				if (hits.length === 0) return ok(`No nodes match "${str(a.query)}"`);
				const limit = num(a.limit, 50);
				return ok(`${plural(hits.length, "match")}\n${hits.slice(0, limit).map((n) => `${nodeLine(n)} | ${clip(n.statement)}`).join("\n")}`);
			},
		},
		{
			name: "get_node",
			description: "Full detail for one node: statement, aliases, the chats it came from, and its reasoning chains.",
			inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			async run(a) {
				const { nodes, chains } = d.graph();
				const node = nodes.find((n) => n.id === str(a.id));
				if (!node) return fail(`No node with id ${str(a.id)}`);
				const names = new Map(nodes.map((n) => [n.id, n.name]));
				const titles = d.chatTitles();
				const sources = [...new Set(node.provenance.map((p) => p.chatId))].map((c) => titles[c] ?? c);
				const mine = chains.filter((c) => c.conclusion === node.id || c.premises.includes(node.id));
				return ok([
					`${node.id} | ${node.name}`,
					`Statement: ${node.statement}`,
					`Aliases: ${node.aliases.length ? node.aliases.join(" / ") : "(none)"}`,
					`From: ${sources.length ? sources.join(", ") : "(none)"}`,
					`Chains (${plural(new Set(mine.map((c) => c.id)).size, "chain")}):`,
					...[...new Map(mine.map((c) => [c.id, c])).values()].map((c) => `  ${c.premises.map((p) => names.get(p) ?? p).join(" + ")} ⟹ ${names.get(c.conclusion) ?? c.conclusion}`),
				].join("\n"));
			},
		},
		{
			name: "list_chats",
			description: "List the learner's teaching/practice chats (id | title | last activity).",
			inputSchema: { type: "object", properties: {} },
			async run() {
				const chats = d.chats();
				return ok(`${plural(chats.length, "chat")}\n${chats.map((c) => `${c.id} | ${c.title} | ${c.updatedAt}`).join("\n")}`);
			},
		},
		{
			name: "get_chat",
			description: "Summary of one chat: title, kind, message count, phase, and how many graph nodes it touched. No transcript.",
			inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			async run(a) {
				const chat = d.chats().find((c) => c.id === str(a.id));
				if (!chat) return fail(`No chat with id ${str(a.id)}`);
				const touched = d.graph().nodes.filter((n) => n.provenance.some((p) => p.chatId === chat.id)).length;
				return ok(`${chat.id} | ${chat.title}\nKind: ${chat.kind} · Phase: ${chat.phase} · ${plural(chat.messageCount, "message")}\nTouches ${plural(touched, "node")}`);
			},
		},
		{
			name: "rename_chat",
			description: "Rename a chat. Runs immediately.",
			inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"] },
			async run(a) {
				const r = d.renameChat(str(a.id), str(a.title));
				return r.ok ? ok(`Renamed chat ${str(a.id)} to "${str(a.title).trim()}"`) : fail(r.error);
			},
		},
		{
			name: "delete_nodes",
			description: "Permanently delete nodes (and every chain touching them). Requires the learner's approval; can be undone from the chat.",
			inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
			async run(a) {
				const ids = [...new Set(strList(a.ids))];
				if (ids.length === 0) return fail("ids is required");
				const { nodes, chains } = d.graph();
				const lines = ids.map((id) => {
					const n = nodes.find((x) => x.id === id);
					return n ? `Delete "${n.name}" (${id}) — ${plural(chainsTouching(id, chains), "chain")} removed` : `${id} — not found, will be skipped`;
				});
				const decision = await d.requestApproval({ tool: "delete_nodes", title: `Delete ${plural(ids.length, "node")}?`, lines });
				if (!decision.approved) return fail(REJECTED);
				const r = d.deleteNodes(ids);
				if (!r.ok) return fail(r.error);
				return ok(`Deleted ${plural(r.value.deleted.length, "node")} and ${plural(r.value.chainsRemoved, "chain")}.${r.value.missing.length ? ` Not found: ${r.value.missing.join(", ")}.` : ""} The learner can undo this from the chat.`);
			},
		},
		{
			name: "merge_nodes",
			description: "Merge two or more nodes into ONE new node with the name and statement you supply. Old wording is kept as aliases; chains are re-pointed; chains that become self-referential are dropped. Requires the learner's approval (they may edit the name/statement); can be undone from the chat.",
			inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, name: { type: "string" }, statement: { type: "string" } }, required: ["ids", "name", "statement"] },
			async run(a) {
				const ids = [...new Set(strList(a.ids))];
				const name = str(a.name).trim();
				const statement = str(a.statement).trim();
				if (ids.length < 2) return fail("Merging needs at least two distinct node ids");
				if (name === "" || statement === "") return fail("name and statement are required");
				const preview = d.previewMerge(ids);
				if (preview.missing.length > 0) return fail(`Unknown node ids: ${preview.missing.join(", ")}`);
				const decision = await d.requestApproval({
					tool: "merge_nodes",
					title: `Merge ${plural(ids.length, "node")} into one?`,
					lines: [...preview.found.map((f) => `• ${f.name} (${f.id})`), `Chains rewritten: ${preview.chainsRewritten} · dropped: ${preview.chainsDropped}`],
					edit: { name, statement },
				});
				if (!decision.approved) return fail(REJECTED);
				const finalName = decision.edit?.name.trim() || name;
				const finalStatement = decision.edit?.statement.trim() || statement;
				const r = d.mergeNodes({ ids, name: finalName, statement: finalStatement });
				if (!r.ok) return fail(r.error);
				return ok(`Merged ${plural(r.value.nodesMerged, "node")} into ${r.value.newId} ("${finalName}"). ${plural(r.value.chainsRewritten, "chain")} rewritten, ${plural(r.value.chainsDropped, "chain")} dropped. The learner can undo this from the chat.`);
			},
		},
		{
			name: "delete_chats",
			description: "Delete chats. mode 'preserve-graph' keeps the graph nodes the chat created; 'delete-nodes' removes every trace of the chat, including nodes only it created. Requires approval; CANNOT be undone.",
			inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, mode: { type: "string", enum: ["preserve-graph", "delete-nodes"] } }, required: ["ids", "mode"] },
			async run(a) {
				const ids = [...new Set(strList(a.ids))];
				const mode = a.mode;
				if (ids.length === 0) return fail("ids is required");
				if (mode !== "preserve-graph" && mode !== "delete-nodes") return fail('mode must be "preserve-graph" or "delete-nodes"');
				const titles = d.chatTitles();
				const decision = await d.requestApproval({
					tool: "delete_chats",
					title: `Delete ${plural(ids.length, "chat")}?`,
					lines: [...ids.map((id) => `• ${titles[id] ?? id} (${id})`), mode === "preserve-graph" ? "Graph nodes from these chats are kept." : "Nodes created only by these chats are removed too.", "This cannot be undone."],
				});
				if (!decision.approved) return fail(REJECTED);
				const results = await d.deleteChats(ids, mode);
				return results.some((r) => !r.ok) ? { text: results.map((r) => `${r.id}: ${r.message}`).join("\n"), isError: true } : ok(results.map((r) => `${r.id}: ${r.message}`).join("\n"));
			},
		},
	];
	return tools;
}
```

- [ ] **Step 5: Run tests, typecheck, lint, commit**

```bash
NODE_ENV=test npx tsx --test tests/cli-mcp-rpc.test.ts tests/cli-tools.test.ts
npm run typecheck && npm run lint
git add src/agent/cli tests/cli-mcp-rpc.test.ts tests/cli-tools.test.ts
git commit -m "feat(cli): MCP JSON-RPC handler and the nine graph/chat tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
Expected: pass. (`ChatSummary` is exported from `src/core/contracts.ts` via `contracts/chat.ts` — if the import fails, import it from where `ChatSummary` is declared.)

---

### Task 7: Approval broker, turn orchestration, composition root

**Files:**
- Create: `src/server/cli-approvals.ts`, `src/server/cli-turn.ts`, `src/server/cli.ts`
- Modify: `src/server/stores.ts` (add `cliChatStore`, `cliStateStore`), `src/server/index.ts` (add `export * from "./cli.ts";`)
- Test: `tests/cli-approvals.test.ts`, `tests/cli-turn.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `createApprovalBroker(newId?: () => string)` → `{ request(chatId: string, req: CliApprovalRequest, emit: (e: CliWireEvent) => void): Promise<CliApprovalDecision>; decide(chatId: string, approvalId: string, decision: CliApprovalDecision): boolean; rejectAll(chatId: string): void; pendingCount(chatId: string): number }`.
  - `createTurnRegistry()` → `{ begin(chatId: string): TurnEntry | null; get(token: string): TurnEntry | undefined; end(token: string): void }` with `interface TurnEntry { token: string; chatId: string; emit: (e: CliWireEvent) => void; tools?: CliTool[] }`.
  - `startCliTurn(deps: CliTurnDeps, chatId: string, text: string, origin: string): ReadableStream<Uint8Array> | { error: "not_found" | "busy" }`.
  - From `src/server/cli.ts` (re-exported through the server barrel): `listCliChats()`, `createCliChat()`, `getCliChat(id)`, `renameCliChat(id, title)`, `deleteCliChat(id)`, `runCliTurnStream(chatId, text, origin)`, `decideCliApproval(chatId, approvalId, decision): boolean`, `handleCliMcp(token, body): Promise<Record<string, unknown> | null | undefined>` (`undefined` = unknown token → route 404), `readUsageSnapshot()`, `cliUndoInfo()`, `undoCliGraphChange()`.

- [ ] **Step 1: Failing broker test**

`tests/cli-approvals.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CliWireEvent } from "../src/core/contracts.ts";
import { createApprovalBroker } from "../src/server/cli-approvals.ts";

const req = { tool: "merge_nodes", title: "Merge?", lines: ["a"], edit: { name: "N", statement: "S" } };

describe("approval broker", () => {
	it("emits a pending card, resolves on decide, and emits approval-settled", async () => {
		const events: CliWireEvent[] = [];
		const broker = createApprovalBroker(() => "ap1");
		const p = broker.request("chat1", req, (e) => events.push(e));
		assert.deepEqual(events[0], { type: "approval", approval: { id: "ap1", tool: "merge_nodes", title: "Merge?", lines: ["a"], edit: { name: "N", statement: "S" }, status: "pending" } });
		assert.equal(broker.pendingCount("chat1"), 1);
		assert.equal(broker.decide("chat1", "ap1", { approved: true, edit: { name: "X", statement: "Y" } }), true);
		assert.deepEqual(await p, { approved: true, edit: { name: "X", statement: "Y" } });
		assert.deepEqual(events[1], { type: "approval-settled", id: "ap1", approved: true });
		assert.equal(broker.pendingCount("chat1"), 0);
	});
	it("decide for an unknown id or another chat's approval returns false and changes nothing", async () => {
		const broker = createApprovalBroker(() => "ap1");
		const p = broker.request("chat1", req, () => {});
		assert.equal(broker.decide("chat1", "nope", { approved: true }), false);
		assert.equal(broker.decide("chat2", "ap1", { approved: true }), false);
		assert.equal(broker.pendingCount("chat1"), 1);
		broker.rejectAll("chat1");
		assert.deepEqual(await p, { approved: false });
	});
	it("rejectAll rejects every pending approval for that chat only, emitting settled events", async () => {
		const events: CliWireEvent[] = [];
		let n = 0;
		const broker = createApprovalBroker(() => `ap${++n}`);
		const a = broker.request("c1", req, (e) => events.push(e));
		const b = broker.request("c1", req, (e) => events.push(e));
		const other = broker.request("c2", req, () => {});
		broker.rejectAll("c1");
		assert.deepEqual(await Promise.all([a, b]), [{ approved: false }, { approved: false }]);
		assert.equal(events.filter((e) => e.type === "approval-settled").length, 2);
		assert.equal(broker.pendingCount("c2"), 1);
		broker.rejectAll("c2");
		await other;
	});
	it("a second decide on the same approval is ignored", async () => {
		const broker = createApprovalBroker(() => "ap1");
		const p = broker.request("c", req, () => {});
		assert.equal(broker.decide("c", "ap1", { approved: false }), true);
		assert.equal(broker.decide("c", "ap1", { approved: true }), false);
		assert.deepEqual(await p, { approved: false });
	});
});
```

- [ ] **Step 2: Implement `cli-approvals.ts`**

```ts
/**
 * The approval broker: destructive tools park here until the learner answers
 * the card. In-memory by design — an approval only means something while the
 * turn that asked is alive, so nothing outlives the process. Every request
 * is chat-scoped: a decision for one chat can never resolve another's.
 */
import { randomUUID } from "node:crypto";
import type { CliApprovalDecision, CliApprovalRequest, CliWireEvent } from "../core/contracts.ts";

interface Pending {
	chatId: string;
	resolve(d: CliApprovalDecision): void;
	emit(e: CliWireEvent): void;
}

export function createApprovalBroker(newId: () => string = () => randomUUID()) {
	const pending = new Map<string, Pending>();

	function settle(id: string, decision: CliApprovalDecision): void {
		const p = pending.get(id);
		if (!p) return;
		pending.delete(id);
		p.emit({ type: "approval-settled", id, approved: decision.approved });
		p.resolve(decision);
	}

	return {
		request(chatId: string, req: CliApprovalRequest, emit: (e: CliWireEvent) => void): Promise<CliApprovalDecision> {
			const id = newId();
			return new Promise((resolve) => {
				pending.set(id, { chatId, resolve, emit });
				emit({ type: "approval", approval: { id, tool: req.tool, title: req.title, lines: req.lines, ...(req.edit ? { edit: req.edit } : {}), status: "pending" } });
			});
		},
		decide(chatId: string, approvalId: string, decision: CliApprovalDecision): boolean {
			const p = pending.get(approvalId);
			if (!p || p.chatId !== chatId) return false;
			settle(approvalId, decision);
			return true;
		},
		rejectAll(chatId: string): void {
			for (const [id, p] of [...pending]) if (p.chatId === chatId) settle(id, { approved: false });
		},
		pendingCount(chatId: string): number {
			return [...pending.values()].filter((p) => p.chatId === chatId).length;
		},
	};
}
export type ApprovalBroker = ReturnType<typeof createApprovalBroker>;
```
Run `NODE_ENV=test npx tsx --test tests/cli-approvals.test.ts` → pass.

- [ ] **Step 3: Failing turn test**

`tests/cli-turn.test.ts`:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { CliWireEvent } from "../src/core/contracts.ts";
import type { CliRunEvent } from "../src/agent/cli/stream-map.ts";
import { createApprovalBroker } from "../src/server/cli-approvals.ts";
import { createTurnRegistry, startCliTurn, type CliTurnDeps } from "../src/server/cli-turn.ts";
import { createCliChatStore } from "../src/store/cli-chats.ts";
import { createCliStateStore } from "../src/store/cli-state.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-turn-"));
async function drain(stream: ReadableStream<Uint8Array>): Promise<CliWireEvent[]> {
	const text = await new Response(stream).text();
	return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as CliWireEvent);
}

function setup(events: CliRunEvent[] | ((o: { prompt: string; resume?: string; mcpUrl: string; signal: AbortSignal }) => AsyncIterable<CliRunEvent>)) {
	const chats = createCliChatStore(tmp());
	const state = createCliStateStore(tmp());
	const registry = createTurnRegistry();
	const broker = createApprovalBroker();
	const seen: Array<{ prompt: string; resume?: string; mcpUrl: string }> = [];
	const run: CliTurnDeps["run"] = typeof events === "function" ? events : (o) => { seen.push(o); return (async function* () { for (const e of events) yield e; })(); };
	const deps: CliTurnDeps = { chats, state, registry, broker, run, now: () => new Date("2026-10-27T12:00:00.000Z") };
	return { deps, chats, state, registry, broker, seen };
}

describe("startCliTurn", () => {
	it("streams events, persists user + assistant messages and the session id, titles the chat from the first prompt", async () => {
		const t = setup([{ type: "session", id: "sess-9" }, { type: "text", delta: "Hello" }, { type: "usage", usage: { fiveHour: { utilization: 0.1, resetsAt: 1, status: "ok" }, sevenDay: null, capturedAt: "x" } }]);
		const chat = t.chats.create();
		const out = startCliTurn(t.deps, chat.id, "Merge my FINA 411 nodes", "http://127.0.0.1:3000");
		assert.ok(!("error" in out));
		const events = await drain(out as ReadableStream<Uint8Array>);
		assert.deepEqual(events.map((e) => e.type), ["text", "usage", "done"], "session events are internal, not streamed");
		const saved = t.chats.get(chat.id)!;
		assert.equal(saved.cliSessionId, "sess-9");
		assert.equal(saved.title, "Merge my FINA 411 nodes");
		assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant"]);
		assert.deepEqual(saved.messages[1]!.parts, [{ type: "text", text: "Hello" }]);
		assert.equal(t.state.readUsage()?.fiveHour?.utilization, 0.1);
	});
	it("resumes the stored session and hands the runner a token URL on the request origin", async () => {
		const t = setup([]);
		const chat = t.chats.create();
		t.chats.save(chat.id, { cliSessionId: "old" });
		await drain(startCliTurn(t.deps, chat.id, "hi", "http://127.0.0.1:3000") as ReadableStream<Uint8Array>);
		assert.equal(t.seen[0]!.resume, "old");
		assert.match(t.seen[0]!.mcpUrl, /^http:\/\/127\.0\.0\.1:3000\/api\/cli\/mcp\/[A-Za-z0-9_-]{20,}$/);
	});
	it("registers the token during the turn and unregisters it after", async () => {
		const t = setup((o) => (async function* () {
			const token = o.mcpUrl.split("/").pop()!;
			assert.ok(t.registry.get(token), "token live during the turn");
			yield { type: "text", delta: "x" } as const;
		})());
		const chat = t.chats.create();
		await drain(startCliTurn(t.deps, chat.id, "hi", "http://h") as ReadableStream<Uint8Array>);
		assert.equal(t.registry.begin(chat.id) !== null, true, "chat is free again");
	});
	it("a second turn on a busy chat is refused; unknown chat is not_found", () => {
		const t = setup(() => (async function* () { await new Promise(() => {}); })());
		const chat = t.chats.create();
		const first = startCliTurn(t.deps, chat.id, "a", "http://h");
		assert.ok(!("error" in first));
		assert.deepEqual(startCliTurn(t.deps, chat.id, "b", "http://h"), { error: "busy" });
		assert.deepEqual(startCliTurn(t.deps, "cli_nope", "b", "http://h"), { error: "not_found" });
	});
	it("a runner crash becomes an error event and is still persisted; pending approvals are rejected", async () => {
		let chatId = "";
		const t = setup((o) => (async function* () {
			void t.broker.request(chatId, { tool: "x", title: "t", lines: [] }, t.registry.get(o.mcpUrl.split("/").pop()!)!.emit);
			throw new Error("spawn exploded");
		})());
		chatId = t.chats.create().id;
		const events = await drain(startCliTurn(t.deps, chatId, "hi", "http://h") as ReadableStream<Uint8Array>);
		assert.ok(events.some((e) => e.type === "error"));
		assert.equal(t.broker.pendingCount(chatId), 0);
		assert.ok(t.chats.get(chatId)!.messages[1]!.parts.some((p) => p.type === "error"));
	});
});
```

- [ ] **Step 4: Implement `cli-turn.ts`**

```ts
/**
 * One Claude CLI turn as a streamed NDJSON response. Responsibilities, in
 * order: refuse a busy/unknown chat; mint the per-turn MCP token; run the CLI;
 * fold every wire event into the assistant message with the SAME reducer the
 * browser uses; record plan-limit usage; and — in `finally`, however the turn
 * ends — persist, release the token, and reject any approval still parked.
 */
import { randomBytes } from "node:crypto";
import { applyWireEvent, newCliMessage } from "../core/cli-chat.ts";
import { DEFAULT_CLI_TITLE, type CliWireEvent } from "../core/contracts.ts";
import type { CliChatStore, CliStateStore } from "../core/ports.ts";
import type { CliRunEvent } from "../agent/cli/stream-map.ts";
import type { CliTool } from "../agent/cli/mcp-rpc.ts";
import type { ApprovalBroker } from "./cli-approvals.ts";

export interface TurnEntry {
	token: string;
	chatId: string;
	emit: (e: CliWireEvent) => void;
	tools?: CliTool[];
}

export function createTurnRegistry() {
	const byToken = new Map<string, TurnEntry>();
	const activeChats = new Set<string>();
	return {
		begin(chatId: string): TurnEntry | null {
			if (activeChats.has(chatId)) return null;
			const entry: TurnEntry = { token: randomBytes(18).toString("base64url"), chatId, emit: () => {} };
			activeChats.add(chatId);
			byToken.set(entry.token, entry);
			return entry;
		},
		get: (token: string) => byToken.get(token),
		end(token: string): void {
			const e = byToken.get(token);
			if (!e) return;
			byToken.delete(token);
			activeChats.delete(e.chatId);
		},
	};
}
export type TurnRegistry = ReturnType<typeof createTurnRegistry>;

export interface CliTurnDeps {
	chats: CliChatStore;
	state: CliStateStore;
	registry: TurnRegistry;
	broker: ApprovalBroker;
	run(o: { prompt: string; resume?: string; mcpUrl: string; signal: AbortSignal }): AsyncIterable<CliRunEvent>;
	now?: () => Date;
}

export function startCliTurn(deps: CliTurnDeps, chatId: string, text: string, origin: string): ReadableStream<Uint8Array> | { error: "not_found" | "busy" } {
	const chat = deps.chats.get(chatId);
	if (!chat) return { error: "not_found" };
	const entry = deps.registry.begin(chatId);
	if (!entry) return { error: "busy" };

	const now = () => (deps.now ?? (() => new Date()))().toISOString();
	const stamp = Date.now().toString(36);
	const userMsg = newCliMessage("user", `${stamp}-u`, now(), text);
	let assistant = newCliMessage("assistant", `${stamp}-a`, now());
	let sessionId = chat.cliSessionId;
	const ac = new AbortController();
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (ev: CliWireEvent) => {
				assistant = applyWireEvent(assistant, ev);
				try { controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`)); } catch { /* client gone */ }
			};
			entry.emit = send;
			try {
				for await (const ev of deps.run({ prompt: text, resume: chat.cliSessionId, mcpUrl: `${origin}/api/cli/mcp/${entry.token}`, signal: ac.signal })) {
					if (ev.type === "session") { sessionId = ev.id; continue; }
					if (ev.type === "usage") deps.state.writeUsage(ev.usage);
					send(ev);
				}
			} catch (err) {
				send({ type: "error", message: err instanceof Error ? err.message : String(err) });
			} finally {
				deps.broker.rejectAll(chatId);
				deps.registry.end(entry.token);
				deps.chats.save(chatId, { messages: [...chat.messages, userMsg, assistant], ...(sessionId ? { cliSessionId: sessionId } : {}) });
				if (chat.title === DEFAULT_CLI_TITLE) deps.chats.rename(chatId, text.trim().replace(/\s+/g, " ").slice(0, 60) || DEFAULT_CLI_TITLE);
				send({ type: "done" });
				try { controller.close(); } catch { /* already closed */ }
			}
		},
		cancel() { ac.abort(); },
	});
}
```
Note `send({type:"done"})` runs after persistence so the assistant message already excludes it (reducer ignores `done`). Run `NODE_ENV=test npx tsx --test tests/cli-turn.test.ts` → pass (fix the test's `chatIdOf` plumbing if types complain by keeping a local `let chatId` closure instead).

- [ ] **Step 5: Wire stores and the composition root**

In `src/server/stores.ts` add imports and entries:

```ts
import { PATHS } from "../../config.ts";
import { createCliChatStore } from "../store/cli-chats.ts";
import { createCliStateStore } from "../store/cli-state.ts";
```
and extend the object: `cliChatStore: createCliChatStore(path.join(PATHS.cli, "chats")), cliStateStore: createCliStateStore(PATHS.cli),` (add `import path from "node:path";`). Run `npm run typecheck`; if a test fake typed as `Stores` breaks, add the two keys to that fake.

Create `src/server/cli.ts`:

```ts
/**
 * COMPOSITION ROOT for the Claude CLI feature: the only place the pure pieces
 * (tools, broker, registry, graph ops, runner) are plugged to the real stores
 * and the existing server services. Route handlers call only what this file
 * exports (through the server barrel).
 */
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CLI_TOOL_NAMES, createCliTools } from "../agent/cli/tools.ts";
import { handleMcpMessage } from "../agent/cli/mcp-rpc.ts";
import { runCliTurn } from "../agent/cli/runner.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import type { CliApprovalDecision, UsageSnapshot } from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import { previewMerge } from "../core/graph-merge.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import { createApprovalBroker } from "./cli-approvals.ts";
import { createTurnRegistry, startCliTurn } from "./cli-turn.ts";
import { deleteChatSession } from "./chats.ts";
import { graphRevision } from "./graph.ts";
import { createGraphOps } from "./graph-ops.ts";
import { stores } from "./stores.ts";

const broker = createApprovalBroker();
const registry = createTurnRegistry();
const graphOps = createGraphOps({
	graphStore: stores.graphStore,
	state: stores.cliStateStore,
	extractionBusy: () => extractionStatuses().length > 0,
	revision: graphRevision,
	settle: () => settleGraphLayout(stores.graphStore),
});
const workDir = path.join(PATHS.cli, "work");

export const listCliChats = () => stores.cliChatStore.list();
export const createCliChat = () => stores.cliChatStore.create();
export const getCliChat = (id: string) => stores.cliChatStore.get(id);
export const renameCliChat = (id: string, title: string) => stores.cliChatStore.rename(id, title);
export const deleteCliChat = (id: string) => stores.cliChatStore.delete(id);
export const readUsageSnapshot = (): UsageSnapshot | null => stores.cliStateStore.readUsage();
export const cliUndoInfo = () => graphOps.undoInfo();
export const undoCliGraphChange = () => graphOps.undo();
export const decideCliApproval = (chatId: string, approvalId: string, decision: CliApprovalDecision) => broker.decide(chatId, approvalId, decision);

export function runCliTurnStream(chatId: string, text: string, origin: string) {
	return startCliTurn(
		{
			chats: stores.cliChatStore,
			state: stores.cliStateStore,
			registry,
			broker,
			run: (o) => runCliTurn({ prompt: o.prompt, resume: o.resume, mcpUrl: o.mcpUrl, signal: o.signal, workDir, toolNames: CLI_TOOL_NAMES }),
		},
		chatId,
		text,
		origin,
	);
}

/** Returns undefined for an unknown/expired token (route → 404), null for a notification (route → 202). */
export async function handleCliMcp(token: string, body: unknown): Promise<Record<string, unknown> | null | undefined> {
	const entry = registry.get(token);
	if (!entry) return undefined;
	entry.tools ??= createCliTools({
		graph: () => getGraph(stores.graphStore),
		chats: () => stores.chatStore.listChats(),
		chatTitles: () => Object.fromEntries([...stores.chatStore.listChats().map((c) => [c.id, c.title] as const)]),
		renameChat: (id, title) => {
			if (!stores.chatStore.getChat(id)) return { ok: false, code: "not_found", error: `No chat with id ${id}` };
			if (title.trim() === "") return { ok: false, code: "bad_title", error: "title must be non-empty" };
			stores.chatStore.renameChat(id, title.trim());
			return { ok: true, value: null };
		},
		previewMerge: (ids) => previewMerge(stores.graphStore, ids),
		mergeNodes: (input) => graphOps.mergeNodes(input),
		deleteNodes: (ids) => graphOps.deleteNodes(ids),
		deleteChats: async (ids, mode) => {
			const out = [];
			for (const id of ids) {
				const r = await deleteChatSession(id, mode);
				out.push({ id, ok: r.ok, message: r.ok ? `deleted (${r.stats.nodesRemoved} nodes, ${r.stats.chainsRemoved} chains removed)` : r.error });
			}
			return out;
		},
		requestApproval: (req) => broker.request(entry.chatId, req, entry.emit),
	});
	return handleMcpMessage(body, entry.tools);
}
```
`chatTitles` should also include sources the graph lists as chats that no longer exist — unknown ids fall back to the raw id in the tools. Add `export * from "./cli.ts";` to `src/server/index.ts` (after the `./jobs.ts` line).

- [ ] **Step 6: Run everything, commit**

```bash
NODE_ENV=test npx tsx --test tests/cli-approvals.test.ts tests/cli-turn.test.ts
npm run typecheck && npm run lint
git add src tests
git commit -m "feat(cli): approval broker, turn orchestration, composition root

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: API routes

**Files:**
- Create: `app/api/cli/chats/route.ts`, `app/api/cli/chats/[id]/route.ts`, `app/api/cli/chats/[id]/turn/route.ts`, `app/api/cli/chats/[id]/approvals/[approvalId]/route.ts`, `app/api/cli/mcp/[token]/route.ts`, `app/api/cli/usage/route.ts`, `app/api/cli/undo/route.ts`
- Test: `tests/cli-routes.test.ts`

**Interfaces:**
- Consumes: Task 7 exports via `@/src/server`.
- Produces (HTTP): `GET /api/cli/chats` → `{ chats: CliChatSummary[] }`; `POST /api/cli/chats` → `{ id, title }`; `GET /api/cli/chats/:id` → record; `PUT` `{ title }` → `{ title }`; `DELETE` → `{ ok: true }`; `POST /api/cli/chats/:id/turn` body `{ text }` → NDJSON stream (404 / 409 `busy` / 400 `text required`); `POST …/approvals/:approvalId` body `{ approved: boolean, edit?: { name, statement } }` → `{ ok: true }` or 404; `POST /api/cli/mcp/:token` JSON-RPC → JSON, `202` for notifications, `404` for unknown token; `GET /api/cli/usage` → `{ usage: UsageSnapshot | null }`; `GET /api/cli/undo` → `{ undo: { label, at } | null }`; `POST /api/cli/undo` → `{ label }` or `{ error, code }` with 409/404.

- [ ] **Step 1: Failing route-contract test**

Routes are thin; test the logic that is NOT thin — the body validation helper. Put the pure parser in `src/server/cli-http.ts` (create) and test it, then the routes only delegate:

`tests/cli-routes.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseApprovalBody, parseTurnBody } from "../src/server/cli-http.ts";

describe("cli http bodies", () => {
	it("parseTurnBody requires non-blank text and trims it", () => {
		assert.deepEqual(parseTurnBody({ text: "  hi " }), { ok: true, text: "hi" });
		assert.equal(parseTurnBody({ text: "   " }).ok, false);
		assert.equal(parseTurnBody(null).ok, false);
		assert.equal(parseTurnBody({ text: 5 }).ok, false);
	});
	it("parseApprovalBody maps to a decision; an approval may carry an edited identity", () => {
		assert.deepEqual(parseApprovalBody({ approved: false }), { ok: true, decision: { approved: false } });
		assert.deepEqual(parseApprovalBody({ approved: true }), { ok: true, decision: { approved: true } });
		assert.deepEqual(parseApprovalBody({ approved: true, edit: { name: "N", statement: "S" } }), { ok: true, decision: { approved: true, edit: { name: "N", statement: "S" } } });
		assert.equal(parseApprovalBody({ approved: "yes" }).ok, false);
		assert.equal(parseApprovalBody({ approved: true, edit: { name: 1 } }).ok, false);
	});
});
```

- [ ] **Step 2: Implement `src/server/cli-http.ts` and export it**

```ts
/** Request-body parsing for the CLI routes — kept out of the route files so it is testable. */
import type { CliApprovalDecision } from "../core/contracts.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function parseTurnBody(body: unknown): { ok: true; text: string } | { ok: false; error: string } {
	if (!isRecord(body) || typeof body.text !== "string" || body.text.trim() === "") return { ok: false, error: "text is required" };
	return { ok: true, text: body.text.trim() };
}

export function parseApprovalBody(body: unknown): { ok: true; decision: CliApprovalDecision } | { ok: false; error: string } {
	if (!isRecord(body) || typeof body.approved !== "boolean") return { ok: false, error: "approved must be a boolean" };
	if (!body.approved) return { ok: true, decision: { approved: false } };
	if (body.edit === undefined) return { ok: true, decision: { approved: true } };
	const e = body.edit;
	if (!isRecord(e) || typeof e.name !== "string" || typeof e.statement !== "string") return { ok: false, error: "edit needs string name and statement" };
	return { ok: true, decision: { approved: true, edit: { name: e.name, statement: e.statement } } };
}
```
Add `export * from "./cli-http.ts";` to `src/server/index.ts`. Run the test → pass.

- [ ] **Step 3: Write the route files** (each follows the repo idiom; confirm against the Next docs read in Task 1 before writing)

`app/api/cli/chats/route.ts`:

```ts
import { createCliChat, listCliChats } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ chats: listCliChats() });
}

export async function POST() {
	const chat = createCliChat();
	return Response.json({ id: chat.id, title: chat.title });
}
```

`app/api/cli/chats/[id]/route.ts`:

```ts
import { deleteCliChat, getCliChat, renameCliChat } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getCliChat(id);
	return chat ? Response.json(chat) : Response.json({ error: "Not found" }, { status: 404 });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getCliChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string" || body.title.trim() === "") return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	return Response.json({ title: renameCliChat(id, body.title).title });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return deleteCliChat(id) ? Response.json({ ok: true }) : Response.json({ error: "Not found" }, { status: 404 });
}
```

`app/api/cli/chats/[id]/turn/route.ts`:

```ts
import { parseTurnBody, runCliTurnStream } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const parsed = parseTurnBody(await req.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const out = runCliTurnStream(id, parsed.text, new URL(req.url).origin);
	if ("error" in out) {
		return out.error === "busy"
			? Response.json({ error: "A turn is already running in this chat", code: "busy" }, { status: 409 })
			: Response.json({ error: "Not found" }, { status: 404 });
	}
	return new Response(out, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
```

`app/api/cli/chats/[id]/approvals/[approvalId]/route.ts`:

```ts
import { decideCliApproval, parseApprovalBody } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; approvalId: string }> }) {
	const { id, approvalId } = await params;
	const parsed = parseApprovalBody(await req.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	return decideCliApproval(id, approvalId, parsed.decision) ? Response.json({ ok: true }) : Response.json({ error: "No such pending approval" }, { status: 404 });
}
```

`app/api/cli/mcp/[token]/route.ts`:

```ts
import { handleCliMcp } from "@/src/server";

export const dynamic = "force-dynamic";

/** The MCP endpoint the Claude CLI calls during a turn. The unguessable per-turn token IS the credential; it dies when the turn ends. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
	const { token } = await params;
	const body = await req.json().catch(() => null);
	const reply = await handleCliMcp(token, body);
	if (reply === undefined) return Response.json({ error: "Not found" }, { status: 404 });
	if (reply === null) return new Response(null, { status: 202 });
	return Response.json(reply);
}

export async function GET() {
	return new Response(null, { status: 405 });
}
```

`app/api/cli/usage/route.ts`:

```ts
import { readUsageSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ usage: readUsageSnapshot() });
}
```

`app/api/cli/undo/route.ts`:

```ts
import { cliUndoInfo, undoCliGraphChange } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ undo: cliUndoInfo() });
}

export async function POST() {
	const r = undoCliGraphChange();
	if (r.ok) return Response.json({ label: r.value.label });
	return Response.json({ error: r.error, code: r.code }, { status: r.code === "nothing_to_undo" ? 404 : 409 });
}
```

- [ ] **Step 4: Verify and commit**

```bash
NODE_ENV=test npx tsx --test tests/cli-routes.test.ts
npm run typecheck && npm run lint
git add app src tests
git commit -m "feat(cli): API routes for chats, turns, approvals, MCP, usage, undo

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: UI — meter, approval card, CLI chat page, sidebar entry

**Files:**
- Create: `components/cli-format.ts`, `components/usage-meter.tsx`, `components/cli-approval-card.tsx`, `components/cli-chat.tsx`, `components/cli-sidebar.tsx`, `app/cli/[id]/page.tsx`
- Modify: `components/top-bar.tsx` (render `<UsageMeter />` after `{children}`), `components/sidebar.tsx` (insert `<CliSidebarSection />` immediately above `<ActivitySection />`, ~line 844; add the import)
- Test: `tests/render-cli-ui.test.tsx`

**Interfaces:**
- Consumes: `@/src/core` (`UsageSnapshot`, `CliMessage`, `CliApproval`, `CliWireEvent`, `applyWireEvent`, `newCliMessage`, `isUsageStale`, `usagePercent`, `resetLabel`); `Conversation`, `ConversationContent`, `Message`, `MessageContent`, `MessageResponse` from `components/ai-elements`; `TopBar`.
- Produces: `UsageMeterView({ usage, nowMs }: { usage: UsageSnapshot | null; nowMs: number })` (pure), `UsageMeter()` (fetching), `ApprovalCard({ approval, onDecide })` where `onDecide(approved: boolean, edit?: CliApprovalEdit): void`, `CliChat({ chatId, title, initialMessages })`, `CliSidebarSection()`. Browser event `lh:cli-usage` (CustomEvent<UsageSnapshot>) lets `CliChat` refresh the meter without a refetch.

- [ ] **Step 1: Failing render tests**

`tests/render-cli-ui.test.tsx`:

```tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageMeterView } from "../components/usage-meter.tsx";
import { ApprovalCard } from "../components/cli-approval-card.tsx";
import { CliMessageView } from "../components/cli-chat.tsx";

const now = Date.parse("2026-10-27T12:00:00.000Z");
const usage = (capturedAt: string) => ({
	fiveHour: { utilization: 0.12, resetsAt: (now + 125 * 60_000) / 1000, status: "allowed" },
	sevenDay: { utilization: 0.29, resetsAt: (now + 3 * 86_400_000) / 1000, status: "allowed" },
	capturedAt,
});

describe("UsageMeterView", () => {
	it("empty state says no data yet", () => {
		assert.match(renderToStaticMarkup(<UsageMeterView usage={null} nowMs={now} />), /no data yet/i);
	});
	it("shows both percentages and reset labels, no 'as of' when fresh", () => {
		const html = renderToStaticMarkup(<UsageMeterView usage={usage(new Date(now - 60_000).toISOString())} nowMs={now} />);
		assert.match(html, /12%/); assert.match(html, /29%/);
		assert.match(html, /resets in 2h 05m/); assert.match(html, /resets in 3d 0h/);
		assert.doesNotMatch(html, /as of/i);
	});
	it("shows 'as of' when stale", () => {
		const html = renderToStaticMarkup(<UsageMeterView usage={usage(new Date(now - 30 * 60_000).toISOString())} nowMs={now} />);
		assert.match(html, /as of/i);
	});
});

describe("ApprovalCard", () => {
	const base = { id: "a", tool: "merge_nodes", title: "Merge 2 nodes into one?", lines: ["• A (n_a)", "Chains rewritten: 1 · dropped: 0"], status: "pending" as const };
	it("pending merge card shows lines, editable identity inputs, and both buttons", () => {
		const html = renderToStaticMarkup(<ApprovalCard approval={{ ...base, edit: { name: "Merged", statement: "Merged statement" } }} onDecide={() => {}} />);
		assert.match(html, /Merge 2 nodes into one\?/); assert.match(html, /Chains rewritten: 1/);
		assert.match(html, /value="Merged"/); assert.match(html, />Approve</); assert.match(html, />Reject</);
	});
	it("pending delete card has no identity inputs", () => {
		const html = renderToStaticMarkup(<ApprovalCard approval={{ ...base, tool: "delete_nodes" }} onDecide={() => {}} />);
		assert.doesNotMatch(html, /<input/);
	});
	it("settled card shows the outcome and no buttons", () => {
		const html = renderToStaticMarkup(<ApprovalCard approval={{ ...base, status: "approved" }} onDecide={() => {}} />);
		assert.match(html, /Approved/); assert.doesNotMatch(html, />Reject</);
	});
});

describe("CliMessageView", () => {
	it("renders text, a tool call, and an error part", () => {
		const html = renderToStaticMarkup(
			<CliMessageView message={{ id: "m", role: "assistant", createdAt: "t", parts: [{ type: "text", text: "Found 3 nodes" }, { type: "tool", call: { id: "t1", name: "list_nodes", input: {}, status: "done", output: "3 nodes" } }, { type: "error", message: "boom" }] }} onDecide={() => {}} />,
		);
		assert.match(html, /Found 3 nodes/); assert.match(html, /list_nodes/); assert.match(html, /boom/);
	});
});
```
Run → FAIL (modules missing).

- [ ] **Step 2: Implement `components/cli-format.ts` (pure)**

```ts
/** Pure formatting for the CLI chat UI. */
import type { CliToolCall } from "@/src/core";

export function toolSummary(call: CliToolCall): string {
	const input = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {};
	const ids = Array.isArray(input.ids) ? ` ${input.ids.length} id${input.ids.length === 1 ? "" : "s"}` : "";
	const q = typeof input.query === "string" ? ` “${input.query}”` : "";
	return `${call.name}${ids}${q}`;
}

export function timeOfDay(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
```

- [ ] **Step 3: Implement `components/usage-meter.tsx`**

```tsx
"use client";

/**
 * The plan-limit meter (top bar). A pure view (UsageMeterView) over a
 * UsageSnapshot plus a thin fetching shell. It refreshes only when the CLI
 * reports (spec decision 9): on mount, on tab focus, and on the lh:cli-usage
 * event a CLI turn dispatches — never by polling, so it spends no quota.
 */
import { useEffect, useState } from "react";
import { isUsageStale, resetLabel, usagePercent, type UsageSnapshot, type UsageWindow } from "@/src/core";
import { timeOfDay } from "@/components/cli-format";

function Window({ label, w, nowMs }: { label: string; w: UsageWindow | null; nowMs: number }) {
	if (!w) return null;
	const pct = usagePercent(w);
	return (
		<div className="flex items-center gap-2 text-xs" title={`${label}: ${pct}% used, ${resetLabel(w, nowMs)}`}>
			<span className="uppercase tracking-wider text-muted-foreground">{label}</span>
			<span className="h-1.5 w-14 overflow-hidden rounded-full bg-secondary" aria-hidden>
				<span className="block h-full bg-foreground" style={{ width: `${Math.min(100, pct)}%` }} />
			</span>
			<span className="tabular-nums">{pct}%</span>
			<span className="text-muted-foreground">{resetLabel(w, nowMs)}</span>
		</div>
	);
}

export function UsageMeterView({ usage, nowMs }: { usage: UsageSnapshot | null; nowMs: number }) {
	if (!usage) return <span className="text-xs text-muted-foreground" data-testid="usage-meter">Claude plan: no data yet</span>;
	return (
		<div className="flex items-center gap-4" data-testid="usage-meter">
			<Window label="5h" w={usage.fiveHour} nowMs={nowMs} />
			<Window label="7d" w={usage.sevenDay} nowMs={nowMs} />
			{isUsageStale(usage, nowMs) && <span className="text-xs text-muted-foreground">as of {timeOfDay(usage.capturedAt)}</span>}
		</div>
	);
}

export function UsageMeter() {
	const [usage, setUsage] = useState<UsageSnapshot | null>(null);
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		let alive = true;
		const load = () =>
			fetch("/api/cli/usage")
				.then((r) => r.json() as Promise<{ usage: UsageSnapshot | null }>)
				.then((j) => { if (alive) { setUsage(j.usage); setNowMs(Date.now()); } })
				.catch(() => {});
		const onUsage = (e: Event) => { setUsage((e as CustomEvent<UsageSnapshot>).detail); setNowMs(Date.now()); };
		void load();
		window.addEventListener("focus", load);
		window.addEventListener("lh:cli-usage", onUsage);
		const tick = setInterval(() => setNowMs(Date.now()), 60_000); // relabel only; no network
		return () => { alive = false; window.removeEventListener("focus", load); window.removeEventListener("lh:cli-usage", onUsage); clearInterval(tick); };
	}, []);
	return <UsageMeterView usage={usage} nowMs={nowMs} />;
}
```

- [ ] **Step 4: Implement `components/cli-approval-card.tsx`**

```tsx
"use client";

import { useState } from "react";
import type { CliApproval, CliApprovalEdit } from "@/src/core";

/** The in-chat approval card: what will change, optional editable identity, Approve / Reject. */
export function ApprovalCard({ approval, onDecide }: { approval: CliApproval; onDecide: (approved: boolean, edit?: CliApprovalEdit) => void }) {
	const [name, setName] = useState(approval.edit?.name ?? "");
	const [statement, setStatement] = useState(approval.edit?.statement ?? "");
	const pending = approval.status === "pending";
	return (
		<div className="rounded-lg border border-border bg-card p-3 text-sm" data-testid="approval-card">
			<div className="font-medium">{approval.title}</div>
			<ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
				{approval.lines.map((l, i) => <li key={i}>{l}</li>)}
			</ul>
			{approval.edit && pending && (
				<div className="mt-3 space-y-2">
					<label className="block text-xs uppercase tracking-wider text-muted-foreground">Name
						<input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm normal-case tracking-normal text-foreground" value={name} onChange={(e) => setName(e.target.value)} />
					</label>
					<label className="block text-xs uppercase tracking-wider text-muted-foreground">Statement
						<textarea className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm normal-case tracking-normal text-foreground" rows={3} value={statement} onChange={(e) => setStatement(e.target.value)} />
					</label>
				</div>
			)}
			{pending ? (
				<div className="mt-3 flex gap-2">
					<button type="button" className="rounded-md bg-foreground px-3 py-1 text-xs text-background" onClick={() => onDecide(true, approval.edit ? { name, statement } : undefined)}>Approve</button>
					<button type="button" className="rounded-md border border-border px-3 py-1 text-xs" onClick={() => onDecide(false)}>Reject</button>
				</div>
			) : (
				<div className="mt-2 text-xs uppercase tracking-wider text-muted-foreground">{approval.status === "approved" ? "Approved" : "Rejected"}</div>
			)}
		</div>
	);
}
```
`<input … value="Merged">` renders as `value="Merged"` in static markup, satisfying the test.

- [ ] **Step 5: Implement `components/cli-chat.tsx`**

```tsx
"use client";

/**
 * The Claude CLI chat view. A turn is a POST whose NDJSON response is folded
 * with applyWireEvent (the same reducer the server persists with). Approval
 * cards answer through the approvals route; the turn stream settles them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { ApprovalCard } from "@/components/cli-approval-card";
import { toolSummary } from "@/components/cli-format";
import { TopBar } from "@/components/top-bar";
import { applyWireEvent, newCliMessage, type CliApprovalEdit, type CliMessage, type CliWireEvent } from "@/src/core";

export function CliMessageView({ message, onDecide }: { message: CliMessage; onDecide: (approvalId: string, approved: boolean, edit?: CliApprovalEdit) => void }) {
	return (
		<Message from={message.role}>
			<MessageContent>
				{message.parts.map((p, i) => {
					if (p.type === "text") return message.role === "user" ? <span key={i} className="whitespace-pre-wrap">{p.text}</span> : <MessageResponse key={i}>{p.text}</MessageResponse>;
					if (p.type === "tool") return <div key={i} className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground" title={p.call.output}>{toolSummary(p.call)} · {p.call.status}</div>;
					if (p.type === "approval") return <ApprovalCard key={i} approval={p.approval} onDecide={(a, e) => onDecide(p.approval.id, a, e)} />;
					return <div key={i} className="text-sm text-destructive">{p.message}</div>;
				})}
			</MessageContent>
		</Message>
	);
}

export function CliChat({ chatId, title, initialMessages }: { chatId: string; title: string; initialMessages: CliMessage[] }) {
	const [messages, setMessages] = useState<CliMessage[]>(initialMessages);
	const [busy, setBusy] = useState(false);
	const [text, setText] = useState("");
	const [undo, setUndo] = useState<{ label: string } | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const refreshUndo = useCallback(() => {
		fetch("/api/cli/undo").then((r) => r.json() as Promise<{ undo: { label: string } | null }>).then((j) => setUndo(j.undo)).catch(() => {});
	}, []);
	useEffect(refreshUndo, [refreshUndo]);

	const send = useCallback(async () => {
		const prompt = text.trim();
		if (prompt === "" || busy) return;
		setText("");
		setBusy(true);
		const stamp = Date.now().toString(36);
		const now = new Date().toISOString();
		let assistant = newCliMessage("assistant", `${stamp}-a`, now);
		setMessages((m) => [...m, newCliMessage("user", `${stamp}-u`, now, prompt), assistant]);
		const ac = new AbortController();
		abortRef.current = ac;
		const apply = (ev: CliWireEvent) => {
			if (ev.type === "usage") window.dispatchEvent(new CustomEvent("lh:cli-usage", { detail: ev.usage }));
			assistant = applyWireEvent(assistant, ev);
			setMessages((m) => [...m.slice(0, -1), assistant]);
		};
		try {
			const res = await fetch(`/api/cli/chats/${chatId}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: prompt }), signal: ac.signal });
			if (!res.ok || !res.body) {
				const j = (await res.json().catch(() => ({}))) as { error?: string };
				apply({ type: "error", message: j.error ?? `Request failed (${res.status})` });
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line) apply(JSON.parse(line) as CliWireEvent);
				}
			}
		} catch (err) {
			if (!ac.signal.aborted) apply({ type: "error", message: err instanceof Error ? err.message : String(err) });
		} finally {
			setBusy(false);
			abortRef.current = null;
			refreshUndo();
		}
	}, [text, busy, chatId, refreshUndo]);

	const decide = useCallback((approvalId: string, approved: boolean, edit?: CliApprovalEdit) => {
		void fetch(`/api/cli/chats/${chatId}/approvals/${approvalId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved, ...(edit ? { edit } : {}) }) });
	}, [chatId]);

	const doUndo = useCallback(async () => {
		const res = await fetch("/api/cli/undo", { method: "POST" });
		if (!res.ok) {
			const j = (await res.json().catch(() => ({}))) as { error?: string };
			setMessages((m) => [...m, { id: `${Date.now()}-e`, role: "assistant", createdAt: new Date().toISOString(), parts: [{ type: "error", message: j.error ?? "Undo failed" }] }]);
		}
		refreshUndo();
	}, [refreshUndo]);

	return (
		<div className="flex h-dvh flex-col">
			<TopBar><h1 className="font-title text-3xl tracking-tight">{title}</h1></TopBar>
			{undo && !busy && (
				<div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs">
					<span className="text-muted-foreground">{undo.label}</span>
					<button type="button" className="rounded-md border border-border px-2 py-0.5" onClick={() => void doUndo()}>Undo</button>
				</div>
			)}
			<Conversation className="min-h-0 flex-1">
				<ConversationContent>
					{messages.map((m) => <CliMessageView key={m.id} message={m} onDecide={decide} />)}
				</ConversationContent>
			</Conversation>
			<form className="flex gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
				<textarea className="min-h-10 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm" rows={2} placeholder="Ask Claude to tidy your nodes or chats…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
				{busy ? <button type="button" className="rounded-md border border-border px-3 text-sm" onClick={() => abortRef.current?.abort()}>Stop</button> : <button type="submit" className="rounded-md bg-foreground px-3 text-sm text-background" disabled={text.trim() === ""}>Send</button>}
			</form>
		</div>
	);
}
```

- [ ] **Step 6: Implement sidebar section and page**

`components/cli-sidebar.tsx`:

```tsx
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CliChatSummary } from "@/src/core";

/** "Claude CLI" entry + its saved chats. Refetches when the route changes (a new chat or a rename lands). */
export function CliSidebarSection() {
	const router = useRouter();
	const pathname = usePathname();
	const [chats, setChats] = useState<CliChatSummary[]>([]);
	useEffect(() => {
		let alive = true;
		fetch("/api/cli/chats").then((r) => r.json() as Promise<{ chats: CliChatSummary[] }>).then((j) => { if (alive) setChats(j.chats); }).catch(() => {});
		return () => { alive = false; };
	}, [pathname]);
	const create = async () => {
		const res = await fetch("/api/cli/chats", { method: "POST" });
		const j = (await res.json()) as { id: string };
		router.push(`/cli/${j.id}`);
	};
	return (
		<div className="px-3 pb-1 pt-2" data-testid="cli-sidebar">
			<button type="button" onClick={() => void create()} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
				Claude CLI
			</button>
			{chats.map((c) => (
				<button key={c.id} type="button" onClick={() => router.push(`/cli/${c.id}`)} className={`block w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent ${pathname === `/cli/${c.id}` ? "bg-accent" : ""}`}>
					{c.title}
				</button>
			))}
		</div>
	);
}
```

`app/cli/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { CliChat } from "@/components/cli-chat";
import { getCliChat } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function CliChatPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getCliChat(id);
	if (!chat) notFound();
	return <CliChat key={chat.id} chatId={chat.id} title={chat.title} initialMessages={chat.messages} />;
}
```

In `components/top-bar.tsx` add `import { UsageMeter } from "@/components/usage-meter";` and render `<div className="ml-auto"><UsageMeter /></div>` as the LAST child inside `<header>` (after `{children}`). In `components/sidebar.tsx` add `import { CliSidebarSection } from "@/components/cli-sidebar";` and render `<CliSidebarSection />` on the line directly above `<ActivitySection />`.

- [ ] **Step 7: Run tests, gates, then eyeball the UI**

```bash
NODE_ENV=test npx tsx --test tests/render-cli-ui.test.tsx tests/render-sidebar.test.tsx
npm run typecheck && npm run lint
```
Then start the app (`npm run dev`), open `http://localhost:3000`, and check with the built-in browser: (1) the meter shows "Claude plan: no data yet" top-right on home, a chat, and the graph; (2) the sidebar shows "Claude CLI"; (3) clicking it creates a chat and opens `/cli/<id>`. If the meter collides with a surface's own right-aligned controls (the `ml-auto` wrapper plus a child's own `ml-auto`), move the meter into a fixed slot instead — do not change other surfaces' layout. Fix, then commit:

```bash
git add components app tests
git commit -m "feat(cli): CLI chat page, approval card, sidebar entry, and usage meter

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Architecture doc and end-to-end verification

**Files:**
- Modify: `docs/architecture.md`
- Create: `tests/cli-e2e.test.ts` (the whole stack with a fake runner + real stores in temp dirs)

**Interfaces:**
- Consumes: everything above.
- Produces: the recorded third ledger writer; one test proving the main user story end to end.

- [ ] **Step 1: Write the end-to-end test**

`tests/cli-e2e.test.ts` drives: fake runner emits a `tool-start` for `merge_nodes`, calls the MCP handler through the real tools + broker + real `createGraphOps` over an in-memory graph store, approves via `broker.decide`, and asserts the graph merged, the assistant message persisted with an approved approval part, and undo restores it.

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, Position, CliWireEvent } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { createCliTools } from "../src/agent/cli/tools.ts";
import { handleMcpMessage } from "../src/agent/cli/mcp-rpc.ts";
import { previewMerge } from "../src/core/graph-merge.ts";
import { createApprovalBroker } from "../src/server/cli-approvals.ts";
import { createGraphOps } from "../src/server/graph-ops.ts";
import { createTurnRegistry, startCliTurn } from "../src/server/cli-turn.ts";
import { createCliChatStore } from "../src/store/cli-chats.ts";
import { createCliStateStore } from "../src/store/cli-state.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-"));
const node = (id: string, name: string): GraphNode => ({ id, name, statement: `${name}.`, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [{ chatId: "c1", messageId: id }] });

describe("CLI chat end to end (fake CLI, real stack)", () => {
	it("merge via MCP: card → approve → graph merged → assistant message persisted → undo restores", async () => {
		const s = { nodes: [node("n_a", "NPV rule"), node("n_b", "Net present value"), node("n_c", "WACC")], chains: [] as GraphChain[], coverage: [] as never[], checkpoints: [] as never[], positions: {} as Record<string, Position> };
		let revision = 1;
		const graphStore = {
			readNodes: () => s.nodes, readChains: () => s.chains, readCoverage: () => s.coverage, readCheckpoints: () => s.checkpoints, readPositions: () => s.positions,
			writePositions: (p: Record<string, Position>) => { s.positions = p; revision++; },
			rewriteLedgers: (n: Partial<typeof s>) => { Object.assign(s, n); revision++; },
		} as unknown as GraphStore;
		const chats = createCliChatStore(tmp());
		const state = createCliStateStore(tmp());
		const registry = createTurnRegistry();
		const broker = createApprovalBroker(() => "ap-e2e");
		const ops = createGraphOps({ graphStore, state, extractionBusy: () => false, revision: () => revision, settle: () => {}, now: () => new Date("2026-10-27T00:00:00.000Z") });

		const run = (o: { mcpUrl: string }) => (async function* () {
			const entry = registry.get(o.mcpUrl.split("/").pop()!)!;
			const tools = createCliTools({
				graph: () => ({ nodes: s.nodes, chains: s.chains }), chats: () => [], chatTitles: () => ({}),
				renameChat: () => ({ ok: true, value: null }), previewMerge: (ids) => previewMerge(graphStore, ids),
				mergeNodes: (i) => ops.mergeNodes(i), deleteNodes: (ids) => ops.deleteNodes(ids), deleteChats: async () => [],
				requestApproval: (req) => broker.request(entry.chatId, req, entry.emit),
			});
			yield { type: "tool-start", id: "t1", name: "merge_nodes", input: {} } as const;
			const pending = handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "merge_nodes", arguments: { ids: ["n_a", "n_b"], name: "NPV", statement: "Net present value is the discounted sum of cash flows." } } }, tools);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(broker.pendingCount(entry.chatId), 1, "parked on the approval card");
			// the learner approves (via the card's route)
			broker.decide(entry.chatId, "ap-e2e", { approved: true });
			const reply = (await pending) as { result: { content: Array<{ text: string }> } };
			yield { type: "tool-end", id: "t1", output: reply.result.content[0]!.text, isError: false } as const;
			yield { type: "text", delta: "Done." } as const;
		})();
		const chat = chats.create();
		const stream = startCliTurn({ chats, state, registry, broker, run }, chat.id, "merge the NPV nodes", "http://x");
		assert.ok(!("error" in stream));
		const text = await new Response(stream as ReadableStream<Uint8Array>).text();
		const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as CliWireEvent);
		assert.ok(events.some((e) => e.type === "approval"));
		assert.deepEqual(s.nodes.map((n) => n.id).includes("n_c"), true);
		assert.equal(s.nodes.length, 2);
		assert.ok(events.some((e) => e.type === "approval-settled" && e.approved));
		const saved = chats.get(chat.id)!;
		assert.ok(saved.messages[1]!.parts.some((p) => p.type === "approval" && p.approval.status === "approved"));
		assert.ok(saved.messages[1]!.parts.some((p) => p.type === "tool" && p.call.status === "done"));
		assert.ok(ops.undoInfo());
		assert.ok(ops.undo().ok);
		assert.equal(s.nodes.length, 3);
	});
});
```
The broker is built with a deterministic id (`() => "ap-e2e"`) so the harness can answer the card the way the approvals route would. Run: `NODE_ENV=test npx tsx --test tests/cli-e2e.test.ts` → expect PASS.

- [ ] **Step 2: Update `docs/architecture.md`**

Find the places that state the graph has one/ two writers:

```bash
grep -n "sole graph writer\|sole writer\|second destructive\|one writer" docs/architecture.md
```
At each hit, extend the statement so it names **three** writers — extraction (append), deletion (`core/graph-deletion.ts`), and merge (`core/graph-merge.ts`, run only through `src/server/graph-ops.ts`, which owns the extraction gate, the pre-change snapshot, and the undo point). In the §1 systems table add a row:

```
| **Claude CLI chat** — assistant surface | `data/cli/*` (CLI chats, usage snapshot, undo point) | drives the `claude` CLI headless; reaches the app only through an app-run MCP endpoint; graph mutations go through `graph-ops` |
```
and add a short §"Claude CLI chat" describing: the per-turn token-guarded MCP endpoint, the approval broker, hardened CLI flags and why, and that chat deletion is intentionally not undoable.

- [ ] **Step 3: Full gate**

```bash
npm test
npm run lint
npm run typecheck
```
Expected: all green. Fix anything that regressed (most likely a test fake typed as `Stores`, or the sidebar render test needing `fetch` stubbed because `CliSidebarSection` runs in the sidebar tree — if `render-sidebar` fails, guard `fetch` calls in `useEffect` (SSR does not run effects, so this should not occur)).

- [ ] **Step 4: Manual verification against the real `claude` (do not skip)**

```bash
npm run dev
```
In the built-in browser at `http://localhost:3000`: (1) create a CLI chat; ask "list my nodes" → tool rows appear, answer streams; (2) meter updates from "no data yet" to real 5h/7d percentages; (3) ask "merge these two nodes: <pick two real ids>" → approval card appears, edit the name, Approve → graph reflects it (check the home graph), Undo restores; (4) ask to delete a chat → card says "cannot be undone", Reject → nothing deleted; (5) reload the page → conversation and CLI session resume ("what did we just do?"). Report anything that deviates.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md tests/cli-e2e.test.ts
git commit -m "docs+test: record the merge writer and verify the CLI chat end to end

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (spec coverage)

| Spec item | Task |
|---|---|
| Chat UI driving `claude -p` stream-json, `--resume` | 5, 7, 9 |
| App-run MCP, restricted tools, built-ins off, no `data/` access | 1, 5 (`--tools ""`, `--strict-mcp-config`), 6, 8 |
| Approval cards for delete/merge, closing rejects | 6, 7 (`rejectAll` in `finally`), 9 |
| Merge with supplied, editable identity; aliases/provenance union; chain re-point/dedupe/drop; positions; extraction gate; settle | 3, 4 (`settle`), 6 |
| Snapshot + Undo (valid until next graph change) | 4, 9 (Undo bar) — **graph changes only; chat deletion explicitly not undoable (see "Decisions beyond the spec")** |
| Sidebar entry + top-bar meter with popover | 9 — **the meter shows both windows and reset times inline in the top bar rather than in a popover (simpler; flag for owner)** |
| Meter updates per CLI turn only; "as of" when stale; "no data yet" | 2, 5, 9 |
| Saved + resumable chats | 4, 7 |
| Errors: missing CLI / not logged in / non-zero exit | 5 (runner), 9 (error part) |
| Tests incl. fake CLI, mapper, tools, approval flow, merge, undo, 409, stale/empty meter | 2–10 |
| Architecture doc: third ledger writer | 10 |
| Out of scope (node rename/tag, pings, terminal) | not built |

Type consistency check: `CliOpResult`, `CliApprovalRequest/Decision`, `CliWireEvent`, `MergeInput/MergePreview/MergeStats`, `CliToolDeps`, `GraphOpsDeps`, `CliTurnDeps`, `TurnEntry`, `CliRunEvent`, `SpawnProc/CliProc` are each defined once (Tasks 2–7) and used with the same names/signatures afterward. `CLI_TOOL_NAMES` (Task 6) feeds `runCliTurn({ toolNames })` (Task 7).

Known deviations from the spec, to be confirmed by the owner: (1) undo excludes chat deletion; (2) usage detail is inline in the top bar, not a popover; (3) `ANTHROPIC_API_KEY` is stripped from the CLI child env so usage is billed to the subscription.
