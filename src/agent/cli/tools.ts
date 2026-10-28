/**
 * The sixteen tools the Claude CLI may call. A factory: every effect (graph
 * reads, merge/delete, chat ops, group ops, approval) arrives through
 * CliToolDeps, so this layer never imports server or store (import law) and
 * tests need no fs.
 *
 * Read tools, rename_chat and the group tools run immediately; delete_nodes,
 * merge_nodes, delete_chats and delete_group block on requestApproval and
 * write nothing unless approved.
 */
import type { ChatSummary, CliApprovalDecision, CliApprovalRequest, CliOpResult, GraphChain, GraphNode, GroupsState } from "../../core/contracts.ts";
import type { GraphSessionEntry } from "../../core/graph.ts";
import type { MergeInput, MergePreview, MergeStats } from "../../core/graph-merge.ts";
import { groupPathLabel, sessionIdsInGroup } from "../../core/groups.ts";
import { birthSessionOf } from "../../core/session-clusters.ts";
import type { CliTool, CliToolResult } from "./mcp-rpc.ts";

export interface CliToolDeps {
	graph(): { nodes: GraphNode[]; chains: GraphChain[] };
	chats(): ChatSummary[];
	chatTitles(): Record<string, string>;
	renameChat(id: string, title: string): CliOpResult<null>;
	previewMerge(ids: string[]): MergePreview;
	mergeNodes(input: MergeInput): CliOpResult<{ newId: string } & MergeStats>;
	deleteNodes(ids: string[]): CliOpResult<{ deleted: string[]; missing: string[]; chainsRemoved: number }>;
	deleteChats(ids: string[], mode: "preserve-graph" | "delete-nodes"): Promise<Array<{ id: string; ok: boolean; message: string }>>;
	requestApproval(req: CliApprovalRequest): Promise<CliApprovalDecision>;
	groups(): GroupsState;
	/** graphSessionIndex: sessions with their group; groupId filters deep (subgroups included). */
	sessions(groupId?: string): GraphSessionEntry[];
	listGroups(): Array<{ id: string; path: string; sessions: number; nodes: number }>;
	createGroup(input: { name: string; parentGroupId?: string; sessionIds?: string[] }): CliOpResult<GroupChange>;
	addSessionsToGroup(groupId: string, sessionIds: string[]): CliOpResult<GroupChange>;
	removeSessionsFromGroup(sessionIds: string[]): CliOpResult<GroupChange>;
	renameGroup(groupId: string, name: string): CliOpResult<GroupChange>;
	previewDeleteGroup(groupId: string): string;
	deleteGroup(groupId: string): CliOpResult<GroupChange>;
}

/** A group op's count message; `changed` = an undo point was recorded. */
export interface GroupChange {
	message: string;
	changed: boolean;
}

export const CLI_TOOL_NAMES = [
	"list_nodes", "search_nodes", "get_node", "list_chats", "get_chat", "rename_chat", "delete_nodes", "merge_nodes", "delete_chats",
	"list_sessions", "list_groups", "create_group", "add_sessions_to_group", "remove_sessions_from_group", "rename_group", "delete_group",
];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback);
const MAX_LIMIT = 500;
const MAX_CHAINS = 50;
const fail = (text: string): CliToolResult => ({ text, isError: true });
const ok = (text: string): CliToolResult => ({ text });
const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : word.endsWith("ch") ? "es" : "s"}`;
const REJECTED = "The learner rejected this action in the approval card. Nothing was changed. Do not retry the same action; ask what they would like instead.";

export function createCliTools(d: CliToolDeps): CliTool[] {
	const nodeLine = (n: GraphNode) => `${n.id} | ${n.name}`;
	/** The node's group path (through its birth session), or null when ungrouped. */
	const groupOf = (n: GraphNode, groups: GroupsState): string | null => {
		const session = birthSessionOf(n);
		const groupId = session === null ? undefined : groups.sessionGroups[session];
		return groupId === undefined ? null : groupPathLabel(groups.groups, groupId);
	};
	const unknownGroup = (id: string) => fail(`No group "${id}". Call list_groups for the current ids.`);
	const groupResult = (r: CliOpResult<GroupChange>): CliToolResult =>
		!r.ok ? fail(r.error) : ok(r.value.changed ? `${r.value.message} The learner can undo this from the chat.` : r.value.message);
	const chainsTouching = (id: string, chains: GraphChain[]) => new Set(chains.filter((c) => c.conclusion === id || c.premises.includes(id)).map((c) => c.id)).size;

	const tools: CliTool[] = [
		{
			name: "list_nodes",
			description: "List knowledge-graph nodes (id | name, plus | group: path when the node's session is grouped). Optional: limit (default 100), offset, chatId (only nodes that chat touched), groupId (only nodes born in a session of that group or its subgroups).",
			inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" }, chatId: { type: "string" }, groupId: { type: "string" } } },
			async run(a) {
				const chatId = str(a.chatId);
				const groupId = str(a.groupId);
				const groups = d.groups();
				if (groupId !== "" && !groups.groups.some((g) => g.id === groupId)) return unknownGroup(groupId);
				const inGroup = groupId === "" ? null : new Set(sessionIdsInGroup(groups, groupId));
				const all = d.graph().nodes.filter((n) => {
					if (chatId !== "" && !n.provenance.some((p) => p.chatId === chatId)) return false;
					const session = birthSessionOf(n);
					return inGroup === null || (session !== null && inGroup.has(session));
				});
				const limit = Math.min(num(a.limit, 100), MAX_LIMIT);
				const offset = num(a.offset, 0);
				const page = all.slice(offset, offset + limit);
				const line = (n: GraphNode) => {
					const path = groupOf(n, groups);
					return path === null ? nodeLine(n) : `${nodeLine(n)} | group: ${path}`;
				};
				return ok(`${plural(all.length, "node")}${all.length > page.length ? ` (showing ${page.length} from ${offset})` : ""}\n${page.map(line).join("\n")}`);
			},
		},
		{
			name: "search_nodes",
			description: "Case-insensitive substring search over node names, statements and aliases. Returns id | name | statement.",
			inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
			async run(a) {
				const q = str(a.query).toLowerCase();
				if (q === "") return fail("query is required");
				const hits = d.graph().nodes.filter((n) => [n.name, n.statement, ...n.aliases].some((s) => s.toLowerCase().includes(q)));
				if (hits.length === 0) return ok(`No nodes match "${str(a.query)}"`);
				const limit = Math.min(num(a.limit, 50), MAX_LIMIT);
				const shown = hits.slice(0, limit);
				return ok(`${plural(hits.length, "match")}${hits.length > shown.length ? ` (showing first ${shown.length})` : ""}\n${shown.map((n) => `${nodeLine(n)} | ${clip(n.statement)}`).join("\n")}`);
			},
		},
		{
			name: "get_node",
			description: "Full detail for one node: statement, aliases, the chats it came from, its group, and its reasoning chains.",
			inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			async run(a) {
				const { nodes, chains } = d.graph();
				const node = nodes.find((n) => n.id === str(a.id));
				if (!node) return fail(`No node with id ${str(a.id)}`);
				const names = new Map(nodes.map((n) => [n.id, n.name]));
				const titles = d.chatTitles();
				const sources = [...new Set(node.provenance.map((p) => p.chatId))].map((c) => titles[c] ?? c);
				const mine = [...new Map(chains.filter((c) => c.conclusion === node.id || c.premises.includes(node.id)).map((c) => [c.id, c])).values()];
				const chainLines = mine.slice(0, MAX_CHAINS).map((c) => `  ${c.premises.map((p) => names.get(p) ?? p).join(" + ")} ⟹ ${names.get(c.conclusion) ?? c.conclusion}`);
				if (mine.length > MAX_CHAINS) chainLines.push(`  … and ${mine.length - MAX_CHAINS} more`);
				return ok([
					`${node.id} | ${node.name}`,
					`Statement: ${node.statement}`,
					`Aliases: ${node.aliases.length ? node.aliases.join(" / ") : "(none)"}`,
					`From: ${sources.length ? sources.join(", ") : "(none)"}`,
					`Group: ${groupOf(node, d.groups()) ?? "(none)"}`,
					`Chains (${plural(mine.length, "chain")}):`,
					...chainLines,
				].join("\n"));
			},
		},
		{
			name: "list_chats",
			description: "List the learner's teaching/practice chats (id | title | last activity).",
			inputSchema: { type: "object", properties: {} },
			async run() {
				const chats = d.chats();
				return ok(`${plural(chats.length, "chat")}\n${chats.map((c) => `${c.id} | ${c.title} | ${c.updatedAt}`).join("\n")}`);
			},
		},
		{
			name: "get_chat",
			description: "Summary of one chat: title, kind, message count, phase, and how many graph nodes it touched. No transcript.",
			inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			async run(a) {
				const chat = d.chats().find((c) => c.id === str(a.id));
				if (!chat) return fail(`No chat with id ${str(a.id)}`);
				const touched = d.graph().nodes.filter((n) => n.provenance.some((p) => p.chatId === chat.id)).length;
				return ok(`${chat.id} | ${chat.title}\nKind: ${chat.kind} · Phase: ${chat.phase} · ${plural(chat.messageCount, "message")}\nTouches ${plural(touched, "node")}`);
			},
		},
		{
			name: "rename_chat",
			description: "Rename a chat. Runs immediately.",
			inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"] },
			async run(a) {
				const r = d.renameChat(str(a.id), str(a.title));
				return r.ok ? ok(`Renamed chat ${str(a.id)} to "${str(a.title).trim()}"`) : fail(r.error);
			},
		},
		{
			name: "delete_nodes",
			description: "Permanently delete nodes (and every chain touching them). Requires the learner's approval; can be undone from the chat.",
			inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
			async run(a) {
				const ids = [...new Set(strList(a.ids))];
				if (ids.length === 0) return fail("ids is required");
				const { nodes, chains } = d.graph();
				const unknown = ids.filter((id) => !nodes.some((x) => x.id === id));
				if (unknown.length === ids.length) return fail(`No such nodes: ${unknown.join(", ")}. Nothing to delete.`);
				const lines = ids.map((id) => {
					const n = nodes.find((x) => x.id === id);
					return n ? `Delete "${n.name}" (${id}) — ${plural(chainsTouching(id, chains), "chain")} removed` : `${id} — not found, will be skipped`;
				});
				const decision = await d.requestApproval({ tool: "delete_nodes", title: `Delete ${plural(ids.length, "node")}?`, lines });
				if (!decision.approved) return fail(REJECTED);
				const r = d.deleteNodes(ids);
				if (!r.ok) return fail(r.error);
				return ok(`Deleted ${plural(r.value.deleted.length, "node")} and ${plural(r.value.chainsRemoved, "chain")}.${r.value.missing.length ? ` Not found: ${r.value.missing.join(", ")}.` : ""} The learner can undo this from the chat.`);
			},
		},
		{
			name: "merge_nodes",
			description: "Merge two or more nodes into ONE new node with the name and statement you supply. Old wording is kept as aliases; chains are re-pointed; chains that become self-referential are dropped. Requires the learner's approval (they may edit the name/statement); can be undone from the chat.",
			inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, name: { type: "string" }, statement: { type: "string" } }, required: ["ids", "name", "statement"] },
			async run(a) {
				const ids = [...new Set(strList(a.ids))];
				const name = str(a.name).trim();
				const statement = str(a.statement).trim();
				if (ids.length < 2) return fail("Merging needs at least two distinct node ids");
				if (name === "" || statement === "") return fail("name and statement are required");
				const preview = d.previewMerge(ids);
				if (preview.missing.length > 0) return fail(`Unknown node ids: ${preview.missing.join(", ")}`);
				const decision = await d.requestApproval({
					tool: "merge_nodes",
					title: `Merge ${plural(ids.length, "node")} into one?`,
					lines: [...preview.found.map((f) => `• ${f.name} (${f.id})`), `Chains rewritten: ${preview.chainsRewritten} · dropped: ${preview.chainsDropped}`],
					edit: { name, statement },
				});
				if (!decision.approved) return fail(REJECTED);
				// The learner's edit is used verbatim; a blank field is an error, never a silent fallback.
				const finalName = decision.edit ? decision.edit.name.trim() : name;
				const finalStatement = decision.edit ? decision.edit.statement.trim() : statement;
				if (finalName === "" || finalStatement === "") return fail("The edited name and statement must not be blank. Nothing was merged.");
				const r = d.mergeNodes({ ids, name: finalName, statement: finalStatement });
				if (!r.ok) return fail(r.error);
				return ok(`Merged ${plural(r.value.nodesMerged, "node")} into ${r.value.newId} ("${finalName}"). ${plural(r.value.chainsRewritten, "chain")} rewritten, ${plural(r.value.chainsDropped, "chain")} dropped. The learner can undo this from the chat.`);
			},
		},
		{
			name: "delete_chats",
			description: "Delete chats. mode 'preserve-graph' keeps the graph nodes the chat created; 'delete-nodes' removes every trace of the chat, including nodes only it created. Requires approval; CANNOT be undone.",
			inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, mode: { type: "string", enum: ["preserve-graph", "delete-nodes"] } }, required: ["ids", "mode"] },
			async run(a) {
				const ids = [...new Set(strList(a.ids))];
				const mode = a.mode;
				if (ids.length === 0) return fail("ids is required");
				if (mode !== "preserve-graph" && mode !== "delete-nodes") return fail('mode must be "preserve-graph" or "delete-nodes"');
				const known = new Set(d.chats().map((c) => c.id));
				const unknownChats = ids.filter((id) => !known.has(id));
				if (unknownChats.length === ids.length) return fail(`No such chats: ${unknownChats.join(", ")}. Nothing to delete.`);
				const titles = d.chatTitles();
				const decision = await d.requestApproval({
					tool: "delete_chats",
					title: `Delete ${plural(ids.length, "chat")}?`,
					lines: [...ids.map((id) => `• ${titles[id] ?? id} (${id})`), mode === "preserve-graph" ? "Graph nodes from these chats are kept." : "Nodes created only by these chats are removed too.", "This cannot be undone."],
				});
				if (!decision.approved) return fail(REJECTED);
				const results = await d.deleteChats(ids, mode);
				return results.some((r) => !r.ok) ? { text: results.map((r) => `${r.id}: ${r.message}`).join("\n"), isError: true } : ok(results.map((r) => `${r.id}: ${r.message}`).join("\n"));
			},
		},
		{
			name: "list_sessions",
			description: "List the sessions that produced graph nodes — chats and imported notes files (id | name | kind | group | node count). Session ids are what the group tools take. Optional groupId: only sessions in that group or its subgroups.",
			inputSchema: { type: "object", properties: { groupId: { type: "string" } } },
			async run(a) {
				const groupId = str(a.groupId);
				if (groupId !== "" && !d.groups().groups.some((g) => g.id === groupId)) return unknownGroup(groupId);
				const sessions = d.sessions(groupId === "" ? undefined : groupId);
				return ok(`${plural(sessions.length, "session")}\n${sessions.map((s) => `${s.id} | ${s.name} | ${s.kind} | ${s.groupName ?? "(ungrouped)"} | ${plural(s.propositions, "node")}`).join("\n")}`);
			},
		},
		{
			name: "list_groups",
			description: "List the knowledge map's groups (id | path | session count | node count, subgroups included).",
			inputSchema: { type: "object", properties: {} },
			async run() {
				const groups = d.listGroups();
				if (groups.length === 0) return ok("There are no groups yet.");
				return ok(groups.map((g) => `${g.id} | ${g.path} | ${plural(g.sessions, "session")} | ${plural(g.nodes, "node")}`).join("\n"));
			},
		},
		{
			name: "create_group",
			description: "Create a named group on the learner's knowledge map, optionally nested under another group (parentGroupId) and optionally filled with sessions (ids from list_sessions). A group holds whole sessions — e.g. all the chapters of one course; nodes and chains are never changed. Runs immediately; can be undone from the chat.",
			inputSchema: { type: "object", properties: { name: { type: "string" }, parentGroupId: { type: "string" }, sessionIds: { type: "array", items: { type: "string" } } }, required: ["name"] },
			async run(a) {
				const parentGroupId = str(a.parentGroupId);
				const sessionIds = [...new Set(strList(a.sessionIds))];
				return groupResult(d.createGroup({ name: str(a.name), ...(parentGroupId !== "" ? { parentGroupId } : {}), ...(sessionIds.length > 0 ? { sessionIds } : {}) }));
			},
		},
		{
			name: "add_sessions_to_group",
			description: "Move sessions (ids from list_sessions) into a group, including sessions already in another group (they leave it). Nodes and chains are never changed. Runs immediately; can be undone from the chat.",
			inputSchema: { type: "object", properties: { groupId: { type: "string" }, sessionIds: { type: "array", items: { type: "string" } } }, required: ["groupId", "sessionIds"] },
			async run(a) {
				const groupId = str(a.groupId);
				const sessionIds = [...new Set(strList(a.sessionIds))];
				if (groupId === "") return fail("groupId is required");
				if (sessionIds.length === 0) return fail("sessionIds is required");
				return groupResult(d.addSessionsToGroup(groupId, sessionIds));
			},
		},
		{
			name: "remove_sessions_from_group",
			description: "Take sessions out of whatever group they are in (they become ungrouped). Nodes and chains are never changed. Runs immediately; can be undone from the chat.",
			inputSchema: { type: "object", properties: { sessionIds: { type: "array", items: { type: "string" } } }, required: ["sessionIds"] },
			async run(a) {
				const sessionIds = [...new Set(strList(a.sessionIds))];
				if (sessionIds.length === 0) return fail("sessionIds is required");
				return groupResult(d.removeSessionsFromGroup(sessionIds));
			},
		},
		{
			name: "rename_group",
			description: "Rename a group. Runs immediately; can be undone from the chat.",
			inputSchema: { type: "object", properties: { groupId: { type: "string" }, name: { type: "string" } }, required: ["groupId", "name"] },
			async run(a) {
				const groupId = str(a.groupId);
				if (groupId === "") return fail("groupId is required");
				return groupResult(d.renameGroup(groupId, str(a.name)));
			},
		},
		{
			name: "delete_group",
			description: "Delete a group. Its subgroups and sessions move up to its parent (or become ungrouped); nodes and chains are never changed. Requires the learner's approval; can be undone from the chat.",
			inputSchema: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] },
			async run(a) {
				const groupId = str(a.groupId);
				const group = d.groups().groups.find((g) => g.id === groupId);
				if (!group) return unknownGroup(groupId);
				const decision = await d.requestApproval({ tool: "delete_group", title: `Delete group "${group.name}"?`, lines: [d.previewDeleteGroup(groupId)] });
				if (!decision.approved) return fail(REJECTED);
				return groupResult(d.deleteGroup(groupId));
			},
		},
	];
	return tools;
}
