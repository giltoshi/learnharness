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
