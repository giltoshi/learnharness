// THE PROBER'S GRAPH TOOLS (wave 7; understanding levels removed
// 2026-09-27) — pinned behaviors:
// 1. REGISTRATION: the factory registers list_sessions/list_propositions
//    on the prober ONLY when the composition root passes a graphStore
//    (the graphToolsEnabled gate lives server-side; absent store = closed
//    gate — the factory must not reach for settings itself).
// 2. OUTPUT: names only — the owner ruling bars statement text and session
//    contents from the prober's view of the map.
// 3. HONESTY: empty graph, unknown session id — the tools answer in
//    their own voice, never throw, never guess.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools } from "../src/agent/tools.ts";
import { auditorGraphTools } from "../src/agent/tools/graph.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { ChatSummary } from "../src/core/contracts/chat.ts";
import type { GraphChain, GraphNode, GroupsState } from "../src/core/contracts/graph.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (
	id: string,
	name: string,
	provenance: Array<{ chatId: string; messageId: string }>,
): GraphNode => ({
	id,
	name,
	statement: `statement of ${name}`, // must NEVER leak into tool output
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

function fakeStores(
	nodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
		groups?: GroupsState;
	} = {},
): { chatStore: ChatStore; graphStore: GraphStore } {
	const chains: GraphChain[] = [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readChains: () => chains,
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
		readPositions: () => ({}),
		readGroups: () => over.groups ?? { groups: [], sessionGroups: {} },
		writePositions: () => {},
		readClusterLabels: () => [],
		appendClusterLabel: () => {},
		appendNamingRun: () => {},
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatSummary) ?? undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const baseCtx = {
	chatId: "c1",
	deliver: () => {},
	jobStore: stubJobStore,
	spawn: () => {},
};

// ─── registration (the factory gate) ────────────────────────────────────────

describe("prober graph tools — registration", () => {
	it("no graphStore in the context → the tools are absent (gate decided server-side)", () => {
		const { chatStore } = fakeStores([]);
		const tools = createProberTools({ ...baseCtx, chatStore });
		assert.equal("list_sessions" in tools, false);
		assert.equal("list_propositions" in tools, false);
	});

	it("graphStore present → list_sessions + list_propositions join the registry beside the usual set", () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		// The standing set (fix wave 2026-09-20: research + pdf are
		// phase-omnipresent) plus the two graph-map readers.
		assert.deepEqual(Object.keys(tools).sort(), [
			"ask_user_question",
			"find",
			"grep",
			"list_propositions",
			"list_sessions",
			"ls",
			"pdf",
			"probe",
			"probe_done",
			"read",
			"research",
		]);
	});
});

// ─── output shape + the no-prose rule ──────────────────────────────────────

describe("list_sessions", () => {
	it("names, kinds, counts, dates, ids — in the prober's voice, no statements", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n1", "Water cycle", [pt("c1")]),
				node("n2", "Evaporation", [pt("c1")]),
				node("n3", "Nietzsche", [pt("c-file")]),
			],
			{
				chats: [
					{
						id: "c1",
						title: "First lesson",
						createdAt: "2026-09-20T10:00:00.000Z",
						updatedAt: "2026-09-21T10:00:00.000Z",
					},
				],
			},
		);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.match(out, /2 session\(s\) in the knowledge graph, most recent first:/);
		// The chat: name, kind, born count, dates, id — the full resume.
		assert.match(out, /First lesson \(chat, 2 propositions, born 2026-09-20T10:00:00.000Z, last active 2026-09-21T10:00:00.000Z\) — id: c1/);
		// The unrecorded birth session falls back honestly: the id, no fake date.
		assert.match(out, /c-file \(file, 1 proposition, born unknown date\) — id: c-file/);
		// The owner ruling: the map's prose never reaches the prober.
		assert.ok(!out.includes("statement of"));
	});

	it("an empty graph gets an honest answer, not an empty string or a throw", async () => {
		const { chatStore, graphStore } = fakeStores([]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.equal(out, "The knowledge graph is empty — no session has contributed propositions yet.");
	});
});

describe("list_propositions", () => {
	it("names only — what the session covered (2026-09-27: no levels, no dating)", async () => {
		const { chatStore, graphStore } = fakeStores([
			node("n1", "Water cycle", [pt("c1")]),
			node("n2", "Evaporation", [pt("c1")]),
		]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /2 proposition\(s\) covered in this session:/);
		assert.match(out, /- Water cycle/);
		assert.match(out, /- Evaporation/);
		// The owner ruling: no levels, no dating, never the statement text.
		assert.ok(!out.includes("as of"));
		assert.ok(!out.includes("solid"));
		assert.ok(!out.includes("statement of"));
	});

	it("no evaluation machinery at all — the covered list is the whole output", async () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /- Water cycle/);
		assert.ok(!out.includes("never evaluated"));
	});

	it("an unknown session id — honest redirect, not a throw", async () => {
		const { chatStore, graphStore } = fakeStores([node("n1", "Water cycle", [pt("c1")])]);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!("tc", { session: "no-such" })).details as string;
		assert.equal(out, 'No propositions born in session "no-such". Call list_sessions for the current ids.');
	});
});

// ─── the auditor's toolset (2026-09-27 relink) ───────────────────────────────

describe("auditor graph tools", () => {
	const nodes = [
		{ ...node("n1", "Will to power", [pt("c1")]), statement: "The will to power is Nietzsche's central drive.", aliases: ["power drive"] },
		{ ...node("n2", "Eternal recurrence", [pt("c1")]), statement: "Eternal recurrence is the thought experiment of living again.", aliases: [] },
	];
	const { chatStore, graphStore } = fakeStores(nodes);

	it("find: glob over names + statements + aliases, returning id + name + statement + BIRTH SESSION (owner, 2026-09-29)", async () => {
		const tools = auditorGraphTools({ chatStore, graphStore });
		const out = (await tools.find!.execute!("tc", { query: "*will to power*" })).details as string;
		assert.match(out, /1 match\(es\):/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		// The born-in pointer: hits compose with list_propositions.
		assert.match(out, /born in: c1/);
		// Statements and aliases hit too — and a bare term gets implicit stars.
		const byStatement = (await tools.find!.execute!("tc", { query: "living again" })).details as string;
		assert.match(byStatement, /n2 :: Eternal recurrence/);
		const byAlias = (await tools.find!.execute!("tc", { query: "power drive" })).details as string;
		assert.match(byAlias, /n1/);
		const miss = (await tools.find!.execute!("tc", { query: "*nothing matches this*" })).details as string;
		assert.equal(miss, 'No existing proposition matches "*nothing matches this*".');
	});

	it("list_sessions: names, kinds, counts, ids — NO timestamps (identity work needs content, not chronology)", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes, {
			chats: [{ id: "c1", title: "Nietzsche seminar", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-21T10:00:00.000Z" }],
		});
		const tools = auditorGraphTools({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.match(out, /1 session\(s\):/);
		assert.match(out, /Nietzsche seminar \(chat, 2 propositions\) — id: c1/);
		assert.ok(!out.includes("2026-09-20"), "no dates in the auditor's view");
	});

	it("list_propositions: FULL statement text (identity work), no dates", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes);
		const tools = auditorGraphTools({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /2 proposition\(s\) born in this session:/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		assert.ok(!out.includes("2026-09"), "no dates in the auditor's view");
		const miss = (await tools.list_propositions!.execute!("tc", { session: "no-such" })).details as string;
		assert.equal(miss, 'No propositions born in session "no-such". Call list_sessions for the current ids.');
	});
});

// ─── session groups (group filter + group label) ────────────────────────────

describe("graph tools — session groups", () => {
	// g1 "FINA 411" holds src_a directly and, via the subgroup g2 "Risk",
	// src_c; src_b is ungrouped; g3 "Empty" has no sessions; g4 "Quiet" has
	// a session that never birthed a proposition.
	const groups: GroupsState = {
		groups: [
			{ id: "g1", name: "FINA 411" },
			{ id: "g2", name: "Risk", parentGroupId: "g1" },
			{ id: "g3", name: "Empty" },
			{ id: "g4", name: "Quiet" },
		],
		sessionGroups: { src_a: "g1", src_c: "g2", src_quiet: "g4" },
	};
	const nodes = [
		node("n1", "Time value of money", [pt("src_a")]),
		node("n2", "Discounting", [pt("src_a")]),
		node("n3", "Unsorted idea", [pt("src_b")]),
		node("n4", "Value at risk", [pt("src_c")]),
	];
	const { chatStore, graphStore } = fakeStores(nodes, { groups });
	const prober = () => createProberTools({ ...baseCtx, chatStore, graphStore });
	const auditor = () => auditorGraphTools({ chatStore, graphStore });
	const run = async (tools: Record<string, { execute?: (id: string, input: any) => Promise<{ details?: unknown }> }>, name: string, input: object) =>
		(await tools[name]!.execute!("tc", input)).details as string;
	const lineFor = (out: string, id: string) => out.split("\n").find((l) => l.includes(`id: ${id}`)) ?? "";

	it("prober list_sessions shows each session's group (before the id) and filters by groupId", async () => {
		const all = await run(prober(), "list_sessions", {});
		assert.match(lineFor(all, "src_a"), /— group: FINA 411 — id: src_a$/);
		assert.match(lineFor(all, "src_c"), /— group: FINA 411 \/ Risk — id: src_c$/);
		assert.doesNotMatch(lineFor(all, "src_b"), /group:/);
		assert.match(lineFor(all, "src_b"), /— id: src_b$/);

		// Deep filter: g1 includes the subgroup's session, never the ungrouped one.
		const filtered = await run(prober(), "list_sessions", { groupId: "g1" });
		assert.match(filtered, /2 session\(s\) in the knowledge graph/);
		assert.match(filtered, /id: src_a/);
		assert.match(filtered, /id: src_c/);
		assert.doesNotMatch(filtered, /src_b/);
		assert.ok(!filtered.includes("statement of"));

		const sub = await run(prober(), "list_sessions", { groupId: "g2" });
		assert.match(sub, /id: src_c/);
		assert.doesNotMatch(sub, /src_a/);

		assert.equal(await run(prober(), "list_sessions", { groupId: "g3" }), 'No sessions in group "g3".');
		assert.equal(await run(prober(), "list_sessions", { groupId: "nope" }), 'No sessions in group "nope".');
	});

	it("auditor list_sessions shows the group label (before the id) and filters by groupId", async () => {
		const all = await run(auditor(), "list_sessions", {});
		assert.match(lineFor(all, "src_a"), /\(file, 2 propositions\) — group: FINA 411 — id: src_a$/);
		assert.match(lineFor(all, "src_b"), /\(file, 1 proposition\) — id: src_b$/);
		const filtered = await run(auditor(), "list_sessions", { groupId: "g2" });
		assert.match(filtered, /1 session\(s\):/);
		assert.match(filtered, /id: src_c/);
		assert.doesNotMatch(filtered, /src_a|src_b/);
		assert.equal(await run(auditor(), "list_sessions", { groupId: "nope" }), 'No sessions in group "nope".');
	});

	it("prober list_propositions takes a groupId and lists every session in it, names only", async () => {
		const out = await run(prober(), "list_propositions", { groupId: "g1" });
		assert.match(out, /^3 proposition\(s\) across 2 session\(s\) in this group:/);
		assert.match(out, /Session src_a \(id: src_a\):\n- Time value of money\n- Discounting/);
		assert.match(out, /Session src_c \(id: src_c\):\n- Value at risk/);
		// Sessions are separated by a blank line.
		assert.match(out, /Discounting\n\nSession src_c/);
		assert.doesNotMatch(out, /Unsorted idea/);
		// The owner ruling holds for groups too: names only, never statements.
		assert.ok(!out.includes("statement of"));
	});

	it("auditor list_propositions with a groupId carries the full statements per session", async () => {
		const out = await run(auditor(), "list_propositions", { groupId: "g2" });
		assert.match(out, /^1 proposition\(s\) across 1 session\(s\) in this group:/);
		assert.match(out, /Session src_c \(id: src_c\):\n- n4 :: Value at risk\n  statement: statement of Value at risk/);
		assert.doesNotMatch(out, /Unsorted idea/);
	});

	it("list_propositions group edge cases: no sessions, no propositions, unknown group", async () => {
		for (const tools of [prober(), auditor()]) {
			assert.equal(await run(tools, "list_propositions", { groupId: "g3" }), 'No sessions in group "g3".');
			assert.equal(
				await run(tools, "list_propositions", { groupId: "g4" }),
				'No propositions born in any session of group "g4".',
			);
			assert.equal(await run(tools, "list_propositions", { groupId: "nope" }), 'No group "nope".');
		}
	});

	it("list_propositions needs exactly one of session / groupId", async () => {
		for (const tools of [prober(), auditor()]) {
			assert.match(await run(tools, "list_propositions", {}), /exactly one of/);
			assert.match(await run(tools, "list_propositions", { session: "src_a", groupId: "g1" }), /exactly one of/);
		}
	});

	it("a single session is still listed exactly as before when groups exist", async () => {
		const out = await run(prober(), "list_propositions", { session: "src_a" });
		assert.equal(out, "2 proposition(s) covered in this session:\n- Time value of money\n- Discounting");
	});
});
