import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GroupsState } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { restoreLedgers, snapshotLedgers } from "../src/core/ledger-snapshot.ts";

function store() {
	const s = {
		nodes: [{ id: "n1" }], chains: [{ id: "arg_1" }], coverage: [{ chatId: "c" }], checkpoints: [{ chatId: "c" }], positions: { n1: { x: 1, y: 2 } } as Record<string, { x: number; y: number }>,
		groups: { groups: [{ id: "grp_1", name: "FINA" }], sessionGroups: { c: "grp_1" } } as GroupsState,
	};
	const port = {
		readNodes: () => s.nodes, readChains: () => s.chains, readCoverage: () => s.coverage, readCheckpoints: () => s.checkpoints,
		readPositions: () => s.positions, writePositions: (p: typeof s.positions) => { s.positions = p; },
		rewriteLedgers: (n: Partial<typeof s>) => Object.assign(s, n),
		readGroups: () => s.groups, writeGroups: (g: GroupsState) => { s.groups = g; },
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
	it("round-trips groups.json too", () => {
		const { s, port } = store();
		const snap = snapshotLedgers(port);
		s.groups = { groups: [], sessionGroups: {} };
		restoreLedgers(port, snap);
		assert.deepEqual(s.groups, { groups: [{ id: "grp_1", name: "FINA" }], sessionGroups: { c: "grp_1" } });
	});
	it("an old snapshot without groups restores the ledgers and leaves groups alone", () => {
		const { s, port } = store();
		const { groups: _omit, ...old } = snapshotLedgers(port);
		s.nodes = [];
		s.groups = { groups: [], sessionGroups: {} };
		restoreLedgers(port, old);
		assert.deepEqual(s.nodes, [{ id: "n1" }]);
		assert.deepEqual(s.groups, { groups: [], sessionGroups: {} });
	});
	it("snapshot is not aliased to live arrays", () => {
		const { s, port } = store();
		const snap = snapshotLedgers(port);
		(s.nodes as Array<{ id: string }>).push({ id: "n2" });
		assert.equal(snap.nodes.length, 1);
	});
});
