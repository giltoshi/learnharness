import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphNode, GroupsState } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { graphSessionIndex, graphSnapshot } from "../src/core/graph.ts";

const pt = (chatId: string) => ({ chatId, messageId: "m1" });
const node = (id: string, chatId: string): GraphNode => ({
	id, name: id, statement: `${id} s`, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [pt(chatId)],
});

function deps(groups: GroupsState) {
	const nodes = [node("n1", "src_a"), node("n2", "src_a"), node("n3", "src_a"), node("n4", "src_b")];
	const graphStore = {
		readNodes: () => nodes, readChains: () => [], readCheckpoints: () => [], readCoverage: () => [],
		readSources: () => [
			{ id: "src_a", filePath: "FINA 411/Ch 01.md", importedAt: "2026-10-02T00:00:00.000Z" },
			{ id: "src_b", filePath: "Other.md", importedAt: "2026-10-01T00:00:00.000Z" },
		],
		readPositions: () => ({}), readGroups: () => groups,
	} as unknown as GraphStore;
	const chatStore = { listChats: () => [], getChat: () => undefined } as unknown as ChatStore;
	return { chatStore, graphStore };
}

const groups: GroupsState = {
	groups: [{ id: "g1", name: "FINA 411" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
	sessionGroups: { src_a: "g2" },
};

describe("snapshot carries groups", () => {
	it("exposes groups and the session map verbatim", () => {
		const snap = graphSnapshot(deps(groups));
		assert.deepEqual(snap.groups, groups.groups);
		assert.deepEqual(snap.sessionGroups, groups.sessionGroups);
	});
	it("empty groups file gives empty fields", () => {
		const snap = graphSnapshot(deps({ groups: [], sessionGroups: {} }));
		assert.deepEqual(snap.groups, []);
		assert.deepEqual(snap.sessionGroups, {});
	});
});

describe("graphSessionIndex groups", () => {
	it("labels each session with its group path", () => {
		const idx = graphSessionIndex(deps(groups));
		assert.equal(idx.find((s) => s.id === "src_a")?.groupName, "FINA 411 / Risk");
		assert.equal(idx.find((s) => s.id === "src_b")?.groupId, null);
	});
	it("filters by group deeply", () => {
		assert.deepEqual(graphSessionIndex(deps(groups), { groupId: "g1" }).map((s) => s.id), ["src_a"]);
		assert.deepEqual(graphSessionIndex(deps(groups), { groupId: "nope" }), []);
	});
});
