import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GraphNode, GroupsState } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { groupTools } from "../src/agent/tools/groups.ts";

const pt = (chatId: string) => ({ chatId, messageId: "m1" });
const node = (id: string, chatId: string): GraphNode => ({
	id, name: id, statement: `${id} s`, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [pt(chatId)],
});

let state: GroupsState;
const nodes = [node("a1", "src_a"), node("a2", "src_a"), node("a3", "src_a"), node("b1", "src_b"), node("b2", "src_b")];
const graphStore = {
	readNodes: () => nodes, readChains: () => [], readCheckpoints: () => [], readCoverage: () => [],
	readSources: () => [
		{ id: "src_a", filePath: "A.md", importedAt: "2026-10-01T00:00:00.000Z" },
		{ id: "src_b", filePath: "B.md", importedAt: "2026-10-01T00:00:00.000Z" },
	],
	readPositions: () => ({}),
	readGroups: () => state,
	writeGroups: (s: GroupsState) => { state = s; },
} as unknown as GraphStore;
const chatStore = { listChats: () => [], getChat: () => undefined } as unknown as ChatStore;
const jobStore = {} as unknown as JobStore;
const tools = groupTools({ chatStore, graphStore });

async function run(name: string, input: Record<string, unknown>): Promise<string> {
	const result = await tools[name]!.execute!("call1", input, undefined);
	return result.details as string;
}
const idOf = (out: string) => /\((grp_[0-9a-f]{8})\)/.exec(out)![1]!;

beforeEach(() => { state = { groups: [], sessionGroups: {} }; });

describe("group tools", () => {
	it("create_group returns the id and counts", async () => {
		const out = await run("create_group", { name: "Risk & Return", sessionIds: ["src_a"] });
		assert.match(out, /Created group 'Risk & Return' \(grp_[0-9a-f]{8}\)\. Moved 1 session \(3 nodes\) into it\. 0 chains affected\./);
	});

	it("add/remove/rename/list round trip", async () => {
		const id = idOf(await run("create_group", { name: "A" }));
		assert.match(await run("add_sessions_to_group", { groupId: id, sessionIds: ["src_b"] }), /Moved 1 session \(2 nodes\) into 'A'/);
		assert.match(await run("rename_group", { groupId: id, name: "Alpha" }), /Renamed group 'A' to 'Alpha'/);
		assert.equal(await run("list_groups", {}), `${id} | Alpha | 1 session | 2 nodes`);
		assert.match(await run("remove_sessions_from_group", { sessionIds: ["src_b"] }), /Removed 1 session \(2 nodes\)/);
		assert.equal(await run("list_groups", {}), `${id} | Alpha | 0 sessions | 0 nodes`);
	});

	it("list_groups on an empty map says so", async () => {
		assert.equal(await run("list_groups", {}), "There are no groups yet.");
	});

	it("unknown ids answer in the tool's own voice, never throw", async () => {
		assert.match(await run("add_sessions_to_group", { groupId: "ghost", sessionIds: ["src_a"] }), /No group "ghost"/);
		assert.match(await run("create_group", { name: "X", sessionIds: ["nope"] }), /Unknown session id/);
	});

	it("delete_group previews first and deletes only with the issued token", async () => {
		const id = idOf(await run("create_group", { name: "Gone" }));
		const preview = await run("delete_group", { groupId: id });
		assert.match(preview, /Nothing has been deleted yet/);
		assert.equal(state.groups.length, 1);
		const token = /confirmToken "([0-9a-f]{8})"/.exec(preview)![1]!;
		assert.match(await run("delete_group", { groupId: id, confirmToken: "deadbeef" }), /invalid or expired/);
		assert.equal(state.groups.length, 1);
		assert.match(await run("delete_group", { groupId: id, confirmToken: token }), /Deleted group 'Gone'/);
		assert.equal(state.groups.length, 0);
		assert.match(await run("delete_group", { groupId: id, confirmToken: token }), /invalid or expired/);
	});

	it("a token is bound to its group", async () => {
		const a = idOf(await run("create_group", { name: "A" }));
		const b = idOf(await run("create_group", { name: "B" }));
		const token = /confirmToken "([0-9a-f]{8})"/.exec(await run("delete_group", { groupId: a }))![1]!;
		assert.match(await run("delete_group", { groupId: b, confirmToken: token }), /invalid or expired/);
		assert.equal(state.groups.length, 2);
		assert.match(await run("delete_group", { groupId: a, confirmToken: token }), /Deleted group 'A'/);
		assert.equal(state.groups.length, 1);
	});

	it("the teacher registry carries the tools only when a graph context is passed", () => {
		const without = createTeacherTools({ chatId: "c", chatStore, jobStore, spawn: () => {} } as never);
		assert.equal("create_group" in without, false);
		const withGraph = createTeacherTools({ chatId: "c", chatStore, jobStore, spawn: () => {}, graph: { chatStore, graphStore } } as never);
		for (const name of ["create_group", "add_sessions_to_group", "remove_sessions_from_group", "rename_group", "delete_group", "list_groups"]) {
			assert.ok(name in withGraph, name);
		}
	});
});
