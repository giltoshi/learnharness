import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CliApprovalDecision, CliApprovalRequest, ChatSummary, GraphChain, GraphNode } from "../src/core/contracts.ts";
import { CLI_TOOL_NAMES, createCliTools, type CliToolDeps } from "../src/agent/cli/tools.ts";

const n = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, name, statement: `${name} statement`, aliases: [], createdAt: "t", provenance: [{ chatId: "c1", messageId: "m" }], ...over });
const nodes = [n("n_a", "Time value of money", { aliases: ["TVM"] }), n("n_b", "Discounting"), n("n_c", "Bond pricing", { provenance: [{ chatId: "c2", messageId: "m" }] })];
const chains: GraphChain[] = [{ id: "arg_1", premises: ["n_a", "n_b"], conclusion: "n_c", createdAt: "t", provenance: [{ chatId: "c1", messageId: "m" }] }];
const chatList: ChatSummary[] = [{ id: "c1", title: "FINA 411 wk1", createdAt: "t", updatedAt: "2026-01-02", kind: "teach", messageCount: 4, phase: "teach", pendingQuestion: false, pendingProblem: false }];

function setup(decision: CliApprovalDecision = { approved: true }) {
	const calls = { approvals: [] as CliApprovalRequest[], merges: [] as unknown[], deletes: [] as string[][], chatDeletes: [] as unknown[], renames: [] as unknown[] };
	const deps: CliToolDeps = {
		graph: () => ({ nodes, chains }),
		chats: () => chatList,
		chatTitles: () => ({ c1: "FINA 411 wk1", c2: "Other" }),
		renameChat: (id, title) => { calls.renames.push([id, title]); return { ok: true, value: null }; },
		previewMerge: (ids) => ({ found: ids.filter((i) => nodes.some((x) => x.id === i)).map((id) => ({ id, name: nodes.find((x) => x.id === id)!.name })), missing: ids.filter((i) => !nodes.some((x) => x.id === i)), chainsRewritten: 1, chainsDropped: 0 }),
		mergeNodes: (input) => { calls.merges.push(input); return { ok: true, value: { newId: "n_new", nodesMerged: input.ids.length, chainsRewritten: 1, chainsDropped: 0 } }; },
		deleteNodes: (ids) => { calls.deletes.push(ids); return { ok: true, value: { deleted: ids, missing: [], chainsRemoved: 1 } }; },
		deleteChats: async (ids, mode) => { calls.chatDeletes.push([ids, mode]); return ids.map((id) => ({ id, ok: true, message: "deleted" })); },
		requestApproval: async (req) => { calls.approvals.push(req); return decision; },
	};
	const tools = new Map(createCliTools(deps).map((t) => [t.name, t]));
	return { tools, calls };
}

describe("cli tools", () => {
	it("exposes exactly the nine documented tools", () => {
		assert.deepEqual([...setup().tools.keys()].sort(), [...CLI_TOOL_NAMES].sort());
		assert.equal(CLI_TOOL_NAMES.length, 9);
	});
	it("list_nodes honors limit/offset and chatId filter", async () => {
		const { tools } = setup();
		const all = await tools.get("list_nodes")!.run({});
		assert.match(all.text, /n_a \| Time value of money/);
		assert.match(all.text, /3 nodes/);
		const byChat = await tools.get("list_nodes")!.run({ chatId: "c2" });
		assert.match(byChat.text, /n_c/);
		assert.doesNotMatch(byChat.text, /n_a/);
		const page = await tools.get("list_nodes")!.run({ limit: 1, offset: 1 });
		assert.match(page.text, /n_b/);
		assert.doesNotMatch(page.text, /n_a/);
	});
	it("search_nodes matches name, statement and aliases case-insensitively", async () => {
		const { tools } = setup();
		assert.match((await tools.get("search_nodes")!.run({ query: "tvm" })).text, /n_a/);
		assert.match((await tools.get("search_nodes")!.run({ query: "BOND" })).text, /n_c/);
		assert.match((await tools.get("search_nodes")!.run({ query: "zzz" })).text, /No nodes match/);
	});
	it("get_node shows statement, aliases, source chats and chains with names", async () => {
		const { tools } = setup();
		const r = await tools.get("get_node")!.run({ id: "n_c" });
		assert.match(r.text, /Bond pricing/);
		assert.match(r.text, /Other/);
		assert.match(r.text, /Time value of money \+ Discounting ⟹ Bond pricing/);
		assert.equal((await tools.get("get_node")!.run({ id: "nope" })).isError, true);
	});
	it("list_chats and get_chat", async () => {
		const { tools } = setup();
		assert.match((await tools.get("list_chats")!.run({})).text, /c1 \| FINA 411 wk1/);
		const g = await tools.get("get_chat")!.run({ id: "c1" });
		assert.match(g.text, /FINA 411 wk1/);
		assert.match(g.text, /2 nodes/);
		assert.equal((await tools.get("get_chat")!.run({ id: "x" })).isError, true);
	});
	it("rename_chat runs immediately with no approval", async () => {
		const { tools, calls } = setup();
		await tools.get("rename_chat")!.run({ id: "c1", title: "Midterm prep" });
		assert.deepEqual(calls.renames, [["c1", "Midterm prep"]]);
		assert.equal(calls.approvals.length, 0);
	});
	it("merge_nodes asks approval with the preview, then merges with the edited identity", async () => {
		const { tools, calls } = setup({ approved: true, edit: { name: "Edited", statement: "Edited statement" } });
		const r = await tools.get("merge_nodes")!.run({ ids: ["n_a", "n_b"], name: "Proposed", statement: "Proposed statement" });
		assert.equal(calls.approvals.length, 1);
		assert.equal(calls.approvals[0]!.tool, "merge_nodes");
		assert.deepEqual(calls.approvals[0]!.edit, { name: "Proposed", statement: "Proposed statement" });
		assert.ok(calls.approvals[0]!.lines.some((l) => l.includes("Chains rewritten: 1")));
		assert.deepEqual(calls.merges, [{ ids: ["n_a", "n_b"], name: "Edited", statement: "Edited statement" }]);
		assert.match(r.text, /Merged 2 nodes into n_new/);
	});
	it("merge_nodes rejected → nothing written, tells the model not to retry", async () => {
		const { tools, calls } = setup({ approved: false });
		const r = await tools.get("merge_nodes")!.run({ ids: ["n_a", "n_b"], name: "P", statement: "S" });
		assert.equal(calls.merges.length, 0);
		assert.equal(r.isError, true);
		assert.match(r.text, /rejected/i);
	});
	it("merge_nodes validates before asking: unknown ids, <2 ids, blank identity", async () => {
		const { tools, calls } = setup();
		for (const args of [{ ids: ["n_a", "n_zzz"], name: "x", statement: "y" }, { ids: ["n_a"], name: "x", statement: "y" }, { ids: ["n_a", "n_b"], name: " ", statement: "y" }]) {
			const r = await tools.get("merge_nodes")!.run(args);
			assert.equal(r.isError, true);
		}
		assert.equal(calls.approvals.length, 0);
	});
	it("delete_nodes lists each node and its chain count in the card, then deletes on approval", async () => {
		const { tools, calls } = setup();
		const r = await tools.get("delete_nodes")!.run({ ids: ["n_a"] });
		assert.ok(calls.approvals[0]!.lines.some((l) => l.includes("Time value of money") && l.includes("1 chain")));
		assert.deepEqual(calls.deletes, [["n_a"]]);
		assert.match(r.text, /Deleted 1 node/);
	});
	it("delete_chats card says it cannot be undone; rejection deletes nothing", async () => {
		const { tools, calls } = setup({ approved: false });
		await tools.get("delete_chats")!.run({ ids: ["c1"], mode: "preserve-graph" });
		assert.ok(calls.approvals[0]!.lines.some((l) => /cannot be undone/i.test(l)));
		assert.equal(calls.chatDeletes.length, 0);
		const bad = await tools.get("delete_chats")!.run({ ids: ["c1"], mode: "bogus" });
		assert.equal(bad.isError, true);
	});
});
