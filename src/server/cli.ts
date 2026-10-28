/**
 * COMPOSITION ROOT for the Claude CLI feature: the only place the pure pieces
 * (tools, broker, registry, graph ops, runner) are plugged to the real stores
 * and the existing server services. Route handlers call only what this file
 * exports (through the server barrel).
 */
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CLI_TOOL_NAMES, createCliTools } from "../agent/cli/tools.ts";
import { handleMcpMessage } from "../agent/cli/mcp-rpc.ts";
import { runCliTurn } from "../agent/cli/runner.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import type { CliApprovalDecision, UsageSnapshot } from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import { previewMerge } from "../core/graph-merge.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import { createApprovalBroker } from "./cli-approvals.ts";
import { createTurnRegistry, startCliTurn } from "./cli-turn.ts";
import { deleteChatSession } from "./chats.ts";
import { graphRevision } from "./graph.ts";
import { createGraphOps } from "./graph-ops.ts";
import { stores } from "./stores.ts";

const broker = createApprovalBroker();
const registry = createTurnRegistry();
const graphOps = createGraphOps({
	graphStore: stores.graphStore,
	state: stores.cliStateStore,
	extractionBusy: () => extractionStatuses().length > 0,
	revision: graphRevision,
	settle: () => settleGraphLayout(stores.graphStore),
});
const workDir = path.join(PATHS.cli, "work");

export const listCliChats = () => stores.cliChatStore.list();
export const createCliChat = () => stores.cliChatStore.create();
export const getCliChat = (id: string) => stores.cliChatStore.get(id);
export const renameCliChat = (id: string, title: string) => stores.cliChatStore.rename(id, title);
export const deleteCliChat = (id: string) => stores.cliChatStore.delete(id);
export const readUsageSnapshot = (): UsageSnapshot | null => stores.cliStateStore.readUsage();
export const cliUndoInfo = () => graphOps.undoInfo();
export const undoCliGraphChange = () => graphOps.undo();
export const decideCliApproval = (chatId: string, approvalId: string, decision: CliApprovalDecision) => broker.decide(chatId, approvalId, decision);

export function runCliTurnStream(chatId: string, text: string, origin: string) {
	return startCliTurn(
		{
			chats: stores.cliChatStore,
			state: stores.cliStateStore,
			registry,
			broker,
			run: (o) => runCliTurn({ prompt: o.prompt, resume: o.resume, mcpUrl: o.mcpUrl, signal: o.signal, workDir, toolNames: CLI_TOOL_NAMES }),
		},
		chatId,
		text,
		origin,
	);
}

/** Returns undefined for an unknown/expired token (route → 404), null for a notification (route → 202). */
export async function handleCliMcp(token: string, body: unknown): Promise<Record<string, unknown> | null | undefined> {
	const entry = registry.get(token);
	if (!entry) return undefined;
	entry.tools ??= createCliTools({
		graph: () => getGraph(stores.graphStore),
		chats: () => stores.chatStore.listChats(),
		chatTitles: () => Object.fromEntries(stores.chatStore.listChats().map((c) => [c.id, c.title] as const)),
		renameChat: (id, title) => {
			if (!stores.chatStore.getChat(id)) return { ok: false, code: "not_found", error: `No chat with id ${id}` };
			if (title.trim() === "") return { ok: false, code: "bad_title", error: "title must be non-empty" };
			stores.chatStore.renameChat(id, title.trim());
			return { ok: true, value: null };
		},
		previewMerge: (ids) => previewMerge(stores.graphStore, ids),
		mergeNodes: (input) => graphOps.mergeNodes(input),
		deleteNodes: (ids) => graphOps.deleteNodes(ids),
		deleteChats: async (ids, mode) => {
			const out = [];
			for (const id of ids) {
				try {
					const r = await deleteChatSession(id, mode);
					out.push({ id, ok: r.ok, message: r.ok ? `deleted (${r.stats.nodesRemoved} nodes, ${r.stats.chainsRemoved} chains removed)` : r.error });
				} catch (err) {
					out.push({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
				}
			}
			return out;
		},
		requestApproval: (req) => broker.request(entry.chatId, req, entry.emit),
	});
	return handleMcpMessage(body, entry.tools);
}
