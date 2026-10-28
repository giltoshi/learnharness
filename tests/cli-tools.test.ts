import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CliApprovalDecision, CliApprovalRequest, ChatSummary, GraphChain, GraphNode, GroupsState } from "../src/core/contracts.ts";
import type { GraphSessionEntry } from "../src/core/graph.ts";
import { CLI_TOOL_NAMES, createCliTools, type CliToolDeps } from "../src/agent/cli/tools.ts";

const n = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, name, statement: `${name} statement`, aliases: [], createdAt: "t", provenance: [{ chatId: "c1", messageId: "m" }], ...over });
const nodes = [n("n_a", "Time value of money", { aliases: ["TVM"] }), n("n_b", "Discounting"), n("n_c", "Bond pricing", { provenance: [{ chatId: "c2", messageId: "m" }] })];
const chains: GraphChain[] = [{ id: "arg_1", premises: ["n_a", "n_b"], conclusion: "n_c", createdAt: "t", provenance: [{ chatId: "c1", messageId: "m" }] }];
const groupState: GroupsState = { groups: [{ id: "grp_f", name: "FINA" }, { id: "grp_r", name: "Risk", parentGroupId: "grp_f" }], sessionGroups: { c2: "grp_r" } };
const sessionList: GraphSessionEntry[] = [
	{ id: "c1", name: "FINA 411 wk1", kind: "chat", createdAt: "t", updatedAt: "t", propositions: 2, groupId: null, groupName: null },
	{ id: "c2", name: "Other", kind: "chat", createdAt: "t", updatedAt: "t", propositions: 1, groupId: "grp_r", groupName: "FINA / Risk" },
];
const chatList: ChatSummary[] = [{ id: "c1", title: "FINA 411 wk1", createdAt: "t", updatedAt: "2026-01-02", kind: "teach", messageCount: 4, phase: "teach", pendingQuestion: false, pendingProblem: false }];

function setup(decision: CliApprovalDecision = { approved: true }, over: { nodes?: GraphNode[]; chains?: GraphChain[] } = {}) {
	const gNodes = over.nodes ?? nodes;
	const gChains = over.chains ?? chains;
	const calls = { approvals: [] as CliApprovalRequest[], merges: [] as unknown[], deletes: [] as string[][], chatDeletes: [] as unknown[], renames: [] as unknown[], groupOps: [] as unknown[][] };
	const groupOp = (op: string, changed = true) => (...args: unknown[]) => { calls.groupOps.push([op, ...args]); return { ok: true as const, value: { message: `${op} done.`, changed } }; };
	const deps: CliToolDeps = {
		graph: () => ({ nodes: gNodes, chains: gChains }),
		chats: () => chatList,
		chatTitles: () => ({ c1: "FINA 411 wk1", c2: "Other" }),
		renameChat: (id, title) => { calls.renames.push([id, title]); return { ok: true, value: null }; },
		previewMerge: (ids) => ({ found: ids.filter((i) => nodes.some((x) => x.id === i)).map((id) => ({ id, name: nodes.find((x) => x.id === id)!.name })), missing: ids.filter((i) => !nodes.some((x) => x.id === i)), chainsRewritten: 1, chainsDropped: 0 }),
		mergeNodes: (input) => { calls.merges.push(input); return { ok: true, value: { newId: "n_new", nodesMerged: input.ids.length, chainsRewritten: 1, chainsDropped: 0 } }; },
		deleteNodes: (ids) => { calls.deletes.push(ids); return { ok: true, value: { deleted: ids, missing: [], chainsRemoved: 1 } }; },
		deleteChats: async (ids, mode) => { calls.chatDeletes.push([ids, mode]); return ids.map((id) => ({ id, ok: true, message: "deleted" })); },
		requestApproval: async (req) => { calls.approvals.push(req); return decision; },
		groups: () => groupState,
		sessions: (groupId) => sessionList.filter((e) => groupId === undefined || (groupId === "grp_f" ? e.groupId !== null : e.groupId === groupId)),
		listGroups: () => [{ id: "grp_f", path: "FINA", sessions: 1, nodes: 1 }, { id: "grp_r", path: "FINA / Risk", sessions: 1, nodes: 1 }],
		createGroup: groupOp("create"),
		addSessionsToGroup: groupOp("add"),
		removeSessionsFromGroup: groupOp("remove", false),
		renameGroup: groupOp("rename"),
		previewDeleteGroup: (id) => `Deleting group '${id}' would move 1 session up and move 1 subgroup.`,
		deleteGroup: groupOp("delete"),
	};
	const tools = new Map(createCliTools(deps).map((t) => [t.name, t]));
	return { tools, calls, deps };
}

describe("cli tools", () => {
	it("exposes exactly the sixteen documented tools", () => {
		assert.deepEqual([...setup().tools.keys()].sort(), [...CLI_TOOL_NAMES].sort());
		assert.equal(CLI_TOOL_NAMES.length, 16);
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
	it("search_nodes says when matches exceed limit", async () => {
		const { tools } = setup();
		const r = await tools.get("search_nodes")!.run({ query: "statement", limit: 2 });
		assert.match(r.text, /3 matches \(showing first 2\)/);
		assert.equal(r.text.split("\n").length, 3);
		assert.doesNotMatch((await tools.get("search_nodes")!.run({ query: "statement" })).text, /showing/);
	});
	it("list_nodes and search_nodes cap limit at 500", async () => {
		const many = Array.from({ length: 600 }, (_, i) => n(`n_${i}`, `Node ${i}`));
		const { tools } = setup({ approved: true }, { nodes: many });
		const l = await tools.get("list_nodes")!.run({ limit: 100000 });
		assert.equal(l.text.split("\n").length, 1 + 500);
		const s = await tools.get("search_nodes")!.run({ query: "node", limit: 100000 });
		assert.match(s.text, /600 matches \(showing first 500\)/);
		assert.equal(s.text.split("\n").length, 1 + 500);
	});
	it("get_node caps chain lines at 50 with a trailing count", async () => {
		const many: GraphChain[] = Array.from({ length: 53 }, (_, i) => ({ id: `arg_${i}`, premises: ["n_a"], conclusion: "n_b", createdAt: "t", provenance: [] }));
		const { tools } = setup({ approved: true }, { chains: many });
		const r = await tools.get("get_node")!.run({ id: "n_a" });
		assert.equal(r.text.split("\n").filter((l) => l.includes("⟹")).length, 50);
		assert.match(r.text, /… and 3 more/);
	});
	it("get_node lists a chain id once even if it appears twice", async () => {
		const dup = [chains[0]!, chains[0]!];
		const { tools } = setup({ approved: true }, { chains: dup });
		const r = await tools.get("get_node")!.run({ id: "n_a" });
		assert.match(r.text, /Chains \(1 chain\)/);
		assert.equal(r.text.split("\n").filter((l) => l.includes("⟹")).length, 1);
	});
	it("delete_nodes with no known ids is an isError result and requests no approval", async () => {
		const { tools, calls } = setup();
		const r = await tools.get("delete_nodes")!.run({ ids: ["n_x", "n_y"] });
		assert.equal(r.isError, true);
		assert.match(r.text, /n_x/);
		assert.match(r.text, /n_y/);
		assert.equal(calls.approvals.length, 0);
		assert.equal(calls.deletes.length, 0);
	});
	it("delete_nodes with some unknown ids still asks, listing the unknown as skipped", async () => {
		const { tools, calls } = setup();
		await tools.get("delete_nodes")!.run({ ids: ["n_a", "n_x"] });
		assert.equal(calls.approvals.length, 1);
		assert.ok(calls.approvals[0]!.lines.some((l) => l.includes("n_x") && /skipped/.test(l)));
	});
	it("delete_nodes dedupes ids, rejects empty ids without approval, and a rejection writes nothing", async () => {
		const a = setup();
		await a.tools.get("delete_nodes")!.run({ ids: ["n_a", "n_a"] });
		assert.deepEqual(a.calls.deletes, [["n_a"]]);
		const b = setup();
		const empty = await b.tools.get("delete_nodes")!.run({ ids: [] });
		assert.equal(empty.isError, true);
		assert.equal(b.calls.approvals.length, 0);
		const c = setup({ approved: false });
		const rej = await c.tools.get("delete_nodes")!.run({ ids: ["n_a"] });
		assert.equal(rej.isError, true);
		assert.equal(c.calls.approvals.length, 1);
		assert.equal(c.calls.deletes.length, 0);
	});
	it("delete_chats with no known chat ids is an isError result and requests no approval", async () => {
		const { tools, calls } = setup();
		const r = await tools.get("delete_chats")!.run({ ids: ["zz1", "zz2"], mode: "preserve-graph" });
		assert.equal(r.isError, true);
		assert.match(r.text, /zz1/);
		assert.equal(calls.approvals.length, 0);
		assert.equal(calls.chatDeletes.length, 0);
	});
	it("merge_nodes uses the learner's edit verbatim; a blank edited field is an error and merges nothing", async () => {
		const a = setup({ approved: true, edit: { name: "  ", statement: "Edited statement" } });
		const ra = await a.tools.get("merge_nodes")!.run({ ids: ["n_a", "n_b"], name: "Proposed", statement: "Proposed statement" });
		assert.equal(ra.isError, true);
		assert.deepEqual(a.calls.merges, []);
		const b = setup({ approved: true, edit: { name: " Edited ", statement: " Stmt " } });
		await b.tools.get("merge_nodes")!.run({ ids: ["n_a", "n_b"], name: "Proposed", statement: "Proposed statement" });
		assert.deepEqual(b.calls.merges, [{ ids: ["n_a", "n_b"], name: "Edited", statement: "Stmt" }]);
	});
	it("list_nodes shows each grouped node's group path and filters by groupId including subgroups", async () => {
		const { tools } = setup();
		const all = await tools.get("list_nodes")!.run({});
		assert.match(all.text, /^n_c \| Bond pricing \| group: FINA \/ Risk$/m);
		assert.match(all.text, /^n_a \| Time value of money$/m);
		const deep = await tools.get("list_nodes")!.run({ groupId: "grp_f" });
		assert.match(deep.text, /^1 node$/m);
		assert.match(deep.text, /n_c/);
		assert.doesNotMatch(deep.text, /n_a/);
		const unknown = await tools.get("list_nodes")!.run({ groupId: "grp_zzz" });
		assert.equal(unknown.isError, true);
	});
	it("get_node shows the node's group", async () => {
		const { tools } = setup();
		assert.match((await tools.get("get_node")!.run({ id: "n_c" })).text, /^Group: FINA \/ Risk$/m);
		assert.match((await tools.get("get_node")!.run({ id: "n_a" })).text, /^Group: \(none\)$/m);
	});
	it("list_sessions lists id | name | kind | group | node count, optionally by group", async () => {
		const { tools } = setup();
		const all = await tools.get("list_sessions")!.run({});
		assert.match(all.text, /^2 sessions$/m);
		assert.match(all.text, /^c1 \| FINA 411 wk1 \| chat \| \(ungrouped\) \| 2 nodes$/m);
		assert.match(all.text, /^c2 \| Other \| chat \| FINA \/ Risk \| 1 node$/m);
		const byGroup = await tools.get("list_sessions")!.run({ groupId: "grp_f" });
		assert.doesNotMatch(byGroup.text, /c1/);
		assert.equal((await tools.get("list_sessions")!.run({ groupId: "grp_zzz" })).isError, true);
	});
	it("list_groups lists id | path | sessions | nodes", async () => {
		const { tools } = setup();
		const r = await tools.get("list_groups")!.run({});
		assert.match(r.text, /^grp_r \| FINA \/ Risk \| 1 session \| 1 node$/m);
	});
	it("create/add/remove/rename run immediately, pass their inputs and say the change can be undone", async () => {
		const { tools, calls } = setup();
		const c = await tools.get("create_group")!.run({ name: "FINA 411", parentGroupId: "grp_f", sessionIds: ["c1"] });
		assert.match(c.text, /create done\. The learner can undo this from the chat\./);
		await tools.get("add_sessions_to_group")!.run({ groupId: "grp_f", sessionIds: ["c1", "c1"] });
		const rm = await tools.get("remove_sessions_from_group")!.run({ sessionIds: ["c1"] });
		assert.equal(rm.text, "remove done.");
		await tools.get("rename_group")!.run({ groupId: "grp_f", name: "Finance" });
		assert.deepEqual(calls.groupOps, [
			["create", { name: "FINA 411", parentGroupId: "grp_f", sessionIds: ["c1"] }],
			["add", "grp_f", ["c1"]],
			["remove", ["c1"]],
			["rename", "grp_f", "Finance"],
		]);
		assert.equal(calls.approvals.length, 0);
	});
	it("group tools validate required inputs and map op errors to isError", async () => {
		const { tools, calls } = setup();
		assert.equal((await tools.get("add_sessions_to_group")!.run({ groupId: "grp_f", sessionIds: [] })).isError, true);
		assert.equal((await tools.get("remove_sessions_from_group")!.run({ sessionIds: [] })).isError, true);
		assert.equal((await tools.get("rename_group")!.run({ groupId: "", name: "x" })).isError, true);
		assert.equal(calls.groupOps.length, 0);
		const failing = createCliTools({ ...setup().deps, createGroup: () => ({ ok: false, code: "invalid_name", error: "A group needs a name." }) });
		const r = await failing.find((t) => t.name === "create_group")!.run({ name: " " });
		assert.equal(r.isError, true);
		assert.match(r.text, /needs a name/);
	});
	it("delete_group asks approval with the preview, then deletes", async () => {
		const { tools, calls } = setup();
		const r = await tools.get("delete_group")!.run({ groupId: "grp_f" });
		assert.equal(calls.approvals.length, 1);
		assert.equal(calls.approvals[0]!.tool, "delete_group");
		assert.match(calls.approvals[0]!.title, /FINA/);
		assert.ok(calls.approvals[0]!.lines.some((l) => /move 1 session up/.test(l)));
		assert.deepEqual(calls.groupOps, [["delete", "grp_f"]]);
		assert.match(r.text, /delete done\. The learner can undo this from the chat\./);
	});
	it("delete_group rejected deletes nothing; unknown group asks nothing", async () => {
		const { tools, calls } = setup({ approved: false });
		const r = await tools.get("delete_group")!.run({ groupId: "grp_f" });
		assert.equal(r.isError, true);
		assert.match(r.text, /rejected/i);
		assert.equal(calls.groupOps.length, 0);
		const u = await tools.get("delete_group")!.run({ groupId: "grp_zzz" });
		assert.equal(u.isError, true);
		assert.equal(calls.approvals.length, 1);
	});
});

