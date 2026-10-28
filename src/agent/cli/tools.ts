/**
 * The nine tools the Claude CLI may call. A factory: every effect (graph
 * reads, merge/delete, chat ops, approval) arrives through CliToolDeps, so
 * this layer never imports server or store (import law) and tests need no fs.
 *
 * Read tools and rename_chat run immediately; delete_nodes, merge_nodes and
 * delete_chats block on requestApproval and write nothing unless approved.
 */
import type { ChatSummary, CliApprovalDecision, CliApprovalRequest, CliOpResult, GraphChain, GraphNode } from "../../core/contracts.ts";
import type { MergeInput, MergePreview, MergeStats } from "../../core/graph-merge.ts";
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
}

export const CLI_TOOL_NAMES = ["list_nodes", "search_nodes", "get_node", "list_chats", "get_chat", "rename_chat", "delete_nodes", "merge_nodes", "delete_chats"];

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
	const chainsTouching = (id: string, chains: GraphChain[]) => new Set(chains.filter((c) => c.conclusion === id || c.premises.includes(id)).map((c) => c.id)).size;

	const tools: CliTool[] = [
		{
			name: "list_nodes",
			description: "List knowledge-graph nodes (id | name). Optional: limit (default 100), offset, chatId (only nodes that chat touched).",
			inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" }, chatId: { type: "string" } } },
			async run(a) {
				const chatId = str(a.chatId);
				const all = d.graph().nodes.filter((n) => chatId === "" || n.provenance.some((p) => p.chatId === chatId));
				const limit = Math.min(num(a.limit, 100), MAX_LIMIT);
				const offset = num(a.offset, 0);
				const page = all.slice(offset, offset + limit);
				return ok(`${plural(all.length, "node")}${all.length > page.length ? ` (showing ${page.length} from ${offset})` : ""}\n${page.map(nodeLine).join("\n")}`);
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
			description: "Full detail for one node: statement, aliases, the chats it came from, and its reasoning chains.",
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
	];
	return tools;
}
