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
