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
