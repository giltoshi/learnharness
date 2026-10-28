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
	it("ignores a streamed tool_use start (empty input) and input_json_delta; only the assistant line starts the tool", () => {
		const ev = run([
			{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "mcp__lh__list_nodes", input: {} } } },
			{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } } },
			{ type: "assistant", message: { id: "m5", content: [{ type: "tool_use", id: "t1", name: "mcp__lh__list_nodes", input: { limit: 3 } }] } },
		]);
		assert.deepEqual(ev, [{ type: "tool-start", id: "t1", name: "list_nodes", input: { limit: 3 } }]);
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
