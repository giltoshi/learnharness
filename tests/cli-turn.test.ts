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
	it("cancelling the stream mid-turn frees the chat even if the runner never yields again", async () => {
		const t = setup(() => (async function* () { await new Promise(() => {}); })());
		const chat = t.chats.create();
		const out = startCliTurn(t.deps, chat.id, "a", "http://h") as ReadableStream<Uint8Array>;
		await out.cancel();
		await new Promise((r) => setTimeout(r, 20));
		assert.ok(t.registry.begin(chat.id) !== null, "chat is free after cancel");
	});
});
