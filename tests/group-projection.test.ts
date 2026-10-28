import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GROUP_NODE_PREFIX, projectGroups, type Projection, type ProjectionInput } from "../components/group-projection.ts";

const prop = (id: string, session: string) => ({ id, provenance: [{ chatId: session, messageId: "m" }] });
const base = (): ProjectionInput => ({
	nodes: [
		{ id: "a1", name: "A1" }, { id: "a2", name: "A2" },
		{ id: "b1", name: "B1" }, { id: "c1", name: "C1" },
		{ id: "arg_1", name: "" },
	],
	propositions: [prop("a1", "s_a"), prop("a2", "s_a"), prop("b1", "s_b"), prop("c1", "s_c")],
	edges: [
		{ from: "a1", to: "a2" }, // internal to s_a
		{ from: "a1", to: "b1" }, { from: "a2", to: "b1" }, // two edges a→b: bundle to one
		{ from: "b1", to: "c1" },
		{ from: "a1", to: "arg_1" }, { from: "b1", to: "arg_1" }, { from: "arg_1", to: "c1" },
	],
	logicalEdges: [{ from: "a1", to: "a2" }, { from: "a1", to: "c1" }, { from: "b1", to: "c1" }],
	impLinks: [{ id: "arg_1", premises: ["a1", "b1"], conclusion: "c1" }],
	clusters: [
		{ id: "s_a", label: "A", members: ["a1", "a2"] }, { id: "s_b", label: "B", members: ["b1"] }, { id: "s_c", label: "C", members: ["c1"] },
	],
	groups: [{ id: "g1", name: "FINA" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
	sessionGroups: { s_a: "g2", s_b: "g1" },
	collapsed: new Set(),
});
const at = () => ({ x: 0, y: 0 });

/** Every endpoint the projection emits must be a node it emits. */
const assertNoDangling = (p: Projection) => {
	const ids = new Set(p.nodes.map((n) => n.id));
	const has = (id: string, where: string) => assert.ok(ids.has(id), `${where} references missing node ${id}`);
	for (const e of p.edges) { has(e.from, "edge.from"); has(e.to, "edge.to"); }
	for (const e of p.logicalEdges) { has(e.from, "logicalEdge.from"); has(e.to, "logicalEdge.to"); }
	for (const l of p.impLinks) {
		has(l.id, "impLink.id");
		for (const q of l.premises) has(q, "impLink.premise");
		has(l.conclusion, "impLink.conclusion");
	}
	for (const c of p.clusters) for (const m of c.members) has(m, `cluster ${c.id} member`);
};

describe("projectGroups", () => {
	it("with nothing collapsed leaves the graph as is and boxes each group", () => {
		const p = projectGroups(base(), (id) => ({ x: id === "a1" ? 10 : 0, y: 0 }));
		assertNoDangling(p);
		assert.equal(p.nodes.length, 5);
		assert.equal(p.edges.length, 7);
		assert.deepEqual(p.blobIds, []);
		const fina = p.groupBoxes.find((b) => b.id === "g1")!;
		const risk = p.groupBoxes.find((b) => b.id === "g2")!;
		// arg_1's premises a1 (s_a, g2) and b1 (s_b, g1) tie; the alphabetically-first session s_a wins → g2
		assert.deepEqual([...risk.members].sort(), ["a1", "a2", "arg_1"]);
		assert.equal(risk.level, 0);
		assert.equal(fina.level, 1);
		assert.ok(fina.members.includes("b1") && fina.members.includes("a1"));
	});

	it("collapsing a group replaces its nodes with one blob, drops internal edges and bundles the rest", () => {
		const input = { ...base(), collapsed: new Set(["g2"]) };
		const p = projectGroups(input, (id) => ({ x: id === "a1" ? 0 : id === "a2" ? 10 : 0, y: 0 }));
		const blob = `${GROUP_NODE_PREFIX}g2`;
		assertNoDangling(p);
		assert.deepEqual(p.blobIds, [blob]);
		assert.equal(p.nodes.some((n) => n.id === "a1" || n.id === "a2"), false);
		const b = p.nodes.find((n) => n.id === blob)!;
		assert.equal(b.label, "Risk · 2");
		assert.equal(b.x, 5); // centroid of a1 (0) and a2 (10)
		// a1→a2 internal edge gone; a1→b1 and a2→b1 bundled into one blob→b1
		assert.equal(p.edges.filter((e) => e.from === blob && e.to === "b1").length, 1);
		assert.equal(p.edges.some((e) => e.from === "a1" || e.to === "a2"), false);
		assert.deepEqual(p.logicalEdges.filter((e) => e.from === blob), [{ from: blob, to: "c1" }]);
		// the blob gets its own region so its name shows when zoomed out
		assert.ok(p.clusters.some((c) => c.id === blob && c.label === "Risk" && c.members.join() === blob));
		assert.equal(p.clusters.some((c) => c.id === "s_a"), false);
		// a collapsed group has no box of its own
		assert.equal(p.groupBoxes.some((x) => x.id === "g2"), false);
		// the folded imp node's edges re-point: b1→arg_1 becomes b1→blob, arg_1→c1 becomes blob→c1 (once)
		assert.ok(p.edges.some((e) => e.from === "b1" && e.to === blob));
		assert.equal(p.edges.filter((e) => e.from === blob && e.to === "c1").length, 1);
	});

	it("the outermost collapsed ancestor wins", () => {
		const p = projectGroups({ ...base(), collapsed: new Set(["g1", "g2"]) }, at);
		assertNoDangling(p);
		assert.deepEqual(p.blobIds, [`${GROUP_NODE_PREFIX}g1`]);
		assert.equal(p.nodes.some((n) => n.id === "a1" || n.id === "b1"), false);
		assert.equal(p.nodes.find((n) => n.id === `${GROUP_NODE_PREFIX}g1`)!.label, "FINA · 3");
		assert.equal(p.groupBoxes.length, 0);
	});

	it("collapsing only the parent folds the child's sessions too and bundles to one edge", () => {
		const p = projectGroups({ ...base(), collapsed: new Set(["g1"]) }, at);
		const blob = `${GROUP_NODE_PREFIX}g1`;
		assertNoDangling(p);
		assert.deepEqual(p.blobIds, [blob]);
		assert.equal(p.edges.filter((e) => e.from === blob && e.to === "c1").length, 1);
	});

	it("a surviving imp link re-points a premise that folded into a blob", () => {
		const input: ProjectionInput = {
			...base(),
			nodes: [...base().nodes, { id: "arg_2", name: "" }],
			// arg_2 premises a1 (s_a) and c1 (s_c) tie → alphabetically-first s_a (uncollapsed g2), so arg_2 stays visible
			impLinks: [...base().impLinks, { id: "arg_2", premises: ["a1", "c1"], conclusion: "b1" }],
			edges: [...base().edges, { from: "a1", to: "arg_2" }, { from: "c1", to: "arg_2" }, { from: "arg_2", to: "b1" }],
			groups: [...base().groups, { id: "g3", name: "Tail" }],
			sessionGroups: { s_a: "g2", s_b: "g1", s_c: "g3" },
			collapsed: new Set(["g3"]),
		};
		const p = projectGroups(input, at);
		const blob = `${GROUP_NODE_PREFIX}g3`;
		assertNoDangling(p);
		assert.deepEqual(p.blobIds, [blob]);
		const link = p.impLinks.find((l) => l.id === "arg_2")!;
		assert.ok(link, "arg_2 survives");
		assert.deepEqual([...link.premises].sort(), ["a1", blob]);
		assert.equal(link.conclusion, "b1");
	});

	it("an imp node follows the majority of its premises' sessions", () => {
		const p = projectGroups({ ...base(), collapsed: new Set(["g2"]) }, at);
		// arg_1 premises: a1 (g2) and b1 (g1) → tie → alphabetically-first session s_a → inside the g2 blob
		assert.equal(p.nodes.some((n) => n.id === "arg_1"), false);
		assert.equal(p.impLinks.length, 0);
	});

	it("ungrouped sessions are untouched and no groups means identity", () => {
		const input = { ...base(), groups: [], sessionGroups: {} };
		const p = projectGroups(input, at);
		assertNoDangling(p);
		assert.equal(p.nodes.length, 5);
		assert.deepEqual(p.edges, input.edges);
		assert.deepEqual(p.groupBoxes, []);
		assert.deepEqual(p.clusters.map((c) => c.id), ["s_a", "s_b", "s_c"]);
	});
});
