import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GraphNode, GroupsState } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { GroupError } from "../src/core/groups.ts";
import {
	addSessionsOp, createGroupOp, deleteGroupOp, listGroupsOp, previewDeleteGroupOp,
	pruneSessionOp, removeSessionsOp, renameGroupOp, setGroupParentOp,
} from "../src/core/group-ops.ts";

const pt = (chatId: string) => ({ chatId, messageId: "m1" });
const node = (id: string, chatId: string): GraphNode => ({
	id, name: id, statement: `${id} s`, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [pt(chatId)],
});

let state: GroupsState;
let writes: number;
const nodes = [node("a1", "src_a"), node("a2", "src_a"), node("a3", "src_a"), node("b1", "src_b"), node("b2", "src_b")];
const graphStore = {
	readNodes: () => nodes, readChains: () => [], readCheckpoints: () => [], readCoverage: () => [],
	readSources: () => [
		{ id: "src_a", filePath: "A.md", importedAt: "2026-10-01T00:00:00.000Z" },
		{ id: "src_b", filePath: "B.md", importedAt: "2026-10-01T00:00:00.000Z" },
	],
	readPositions: () => ({}),
	readGroups: () => state,
	writeGroups: (s: GroupsState) => { state = s; writes++; },
} as unknown as GraphStore;
const chatStore = { listChats: () => [], getChat: () => undefined } as unknown as ChatStore;
const deps = { chatStore, graphStore };

beforeEach(() => { state = { groups: [], sessionGroups: {} }; writes = 0; });

describe("createGroupOp", () => {
	it("creates, optionally fills, and reports counts", () => {
		const r = createGroupOp(deps, { name: "Risk & Return", sessionIds: ["src_a", "src_b"] });
		assert.equal(r.movedSessions, 2);
		assert.equal(r.nodes, 5);
		assert.equal(r.chainsAffected, 0);
		assert.equal(r.message, `Created group 'Risk & Return' (${r.groupId}). Moved 2 sessions (5 nodes) into it. 0 chains affected.`);
		assert.equal(state.sessionGroups.src_a, r.groupId);
	});
	it("rejects unknown sessions without writing", () => {
		assert.throws(() => createGroupOp(deps, { name: "X", sessionIds: ["ghost"] }), (e) => e instanceof GroupError && e.code === "unknown_session");
		assert.equal(writes, 0);
	});
});

describe("move / remove / rename / parent", () => {
	it("moves between groups and reports unchanged", () => {
		const a = createGroupOp(deps, { name: "A" }).groupId;
		const b = createGroupOp(deps, { name: "B" }).groupId;
		addSessionsOp(deps, a, ["src_a"]);
		const r = addSessionsOp(deps, b, ["src_a", "src_b"]);
		assert.equal(r.message, "Moved 2 sessions (5 nodes) into 'B'. 0 chains affected.");
		const again = addSessionsOp(deps, b, ["src_a"]);
		assert.equal(again.message, "Moved 0 sessions (0 nodes) into 'B'; 1 already there. 0 chains affected.");
	});
	it("removes", () => {
		const a = createGroupOp(deps, { name: "A", sessionIds: ["src_a"] }).groupId;
		const r = removeSessionsOp(deps, ["src_a", "src_b"]);
		assert.equal(r.message, "Removed 1 session (3 nodes) from their groups. 0 chains affected. 1 was not in a group.");
		assert.equal(state.sessionGroups.src_a, undefined);
		assert.ok(a);
	});
	it("renames and re-parents", () => {
		const a = createGroupOp(deps, { name: "A" }).groupId;
		const b = createGroupOp(deps, { name: "B" }).groupId;
		assert.equal(renameGroupOp(deps, a, "Alpha").message, "Renamed group 'A' to 'Alpha'.");
		assert.equal(setGroupParentOp(deps, b, a).message, "Moved group 'B' into 'Alpha'.");
		assert.equal(setGroupParentOp(deps, b, null).message, "Moved group 'B' to the top level.");
		assert.throws(() => setGroupParentOp(deps, a, a), (e) => e instanceof GroupError && e.code === "cycle");
	});
});

describe("delete", () => {
	it("previews without writing, then deletes with counts", () => {
		const a = createGroupOp(deps, { name: "A", sessionIds: ["src_a"] }).groupId;
		writes = 0;
		assert.equal(previewDeleteGroupOp(deps, a).message, "Deleting group 'A' would leave 1 session ungrouped and move 0 subgroups.");
		assert.equal(writes, 0);
		const r = deleteGroupOp(deps, a);
		assert.equal(r.message, "Deleted group 'A'. 1 session left ungrouped, 0 subgroups moved up. 0 chains affected.");
		assert.deepEqual(state, { groups: [], sessionGroups: {} });
	});
});

describe("listGroupsOp / pruneSessionOp", () => {
	it("lists deep counts sorted by path", () => {
		const a = createGroupOp(deps, { name: "FINA", sessionIds: ["src_b"] }).groupId;
		const b = createGroupOp(deps, { name: "Risk", parentGroupId: a, sessionIds: ["src_a"] }).groupId;
		const list = listGroupsOp(deps);
		assert.deepEqual(list.map((g) => [g.path, g.sessions, g.nodes]), [["FINA", 2, 5], ["FINA / Risk", 1, 3]]);
		assert.equal(list[1]!.id, b);
		assert.equal(list[1]!.parentGroupId, a);
	});
	it("prunes only when the session was grouped", () => {
		createGroupOp(deps, { name: "A", sessionIds: ["src_a"] });
		writes = 0;
		pruneSessionOp(graphStore, "src_b");
		assert.equal(writes, 0);
		pruneSessionOp(graphStore, "src_a");
		assert.equal(writes, 1);
		assert.deepEqual(state.sessionGroups, {});
	});
});
