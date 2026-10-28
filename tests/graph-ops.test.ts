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
