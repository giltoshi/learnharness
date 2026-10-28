import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode, GroupsState, Position, CliWireEvent } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { createCliTools } from "../src/agent/cli/tools.ts";
import { handleMcpMessage } from "../src/agent/cli/mcp-rpc.ts";
import { previewMerge } from "../src/core/graph-merge.ts";
import { createApprovalBroker } from "../src/server/cli-approvals.ts";
import { createGraphOps } from "../src/server/graph-ops.ts";
import { createTurnRegistry, startCliTurn } from "../src/server/cli-turn.ts";
import { createCliChatStore } from "../src/store/cli-chats.ts";
import { createCliStateStore } from "../src/store/cli-state.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-"));
const node = (id: string, name: string): GraphNode => ({ id, name, statement: `${name}.`, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [{ chatId: "c1", messageId: id }] });

/** Runs one merge turn through the real stack; `approved` is the learner's answer to the card. */
async function mergeTurn(approved: boolean) {
	const s = { nodes: [node("n_a", "NPV rule"), node("n_b", "Net present value"), node("n_c", "WACC")], chains: [] as GraphChain[], coverage: [] as never[], checkpoints: [] as never[], positions: {} as Record<string, Position>, groups: { groups: [], sessionGroups: {} } as GroupsState };
	let revision = 1;
	const graphStore = {
		readNodes: () => s.nodes, readChains: () => s.chains, readCoverage: () => s.coverage, readCheckpoints: () => s.checkpoints, readPositions: () => s.positions,
		writePositions: (p: Record<string, Position>) => { s.positions = p; revision++; },
		rewriteLedgers: (n: Partial<typeof s>) => { Object.assign(s, n); revision++; },
		readGroups: () => s.groups, writeGroups: (g: GroupsState) => { s.groups = g; revision++; },
	} as unknown as GraphStore;
	const chatStore = { listChats: () => [] } as unknown as ChatStore;
	const chats = createCliChatStore(tmp());
	const state = createCliStateStore(tmp());
	const registry = createTurnRegistry();
	const broker = createApprovalBroker(() => "ap-e2e");
	const ops = createGraphOps({ graphStore, chatStore, state,extractionBusy: () => false, revision: () => revision, settle: () => {}, now: () => new Date("2026-10-27T00:00:00.000Z") });
	let toolOutput = "";

	const run = (o: { mcpUrl: string }) => (async function* () {
		const entry = registry.get(o.mcpUrl.split("/").pop()!)!;
		const tools = createCliTools({
			graph: () => ({ nodes: s.nodes, chains: s.chains }), chats: () => [], chatTitles: () => ({}),
			renameChat: () => ({ ok: true, value: null }), previewMerge: (ids) => previewMerge(graphStore, ids),
			mergeNodes: (i) => ops.mergeNodes(i), deleteNodes: (ids) => ops.deleteNodes(ids), deleteChats: async () => [],
			requestApproval: (req) => broker.request(entry.chatId, req, entry.emit),
			groups: () => s.groups, sessions: () => [], listGroups: () => [],
			createGroup: (i) => ops.createGroup(i), addSessionsToGroup: (g, ids) => ops.addSessionsToGroup(g, ids), removeSessionsFromGroup: (ids) => ops.removeSessionsFromGroup(ids),
			renameGroup: (g, name) => ops.renameGroup(g, name), previewDeleteGroup: () => "", deleteGroup: (g) => ops.deleteGroup(g),
		});
		yield { type: "tool-start", id: "t1", name: "merge_nodes", input: {} } as const;
		const pending = handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "merge_nodes", arguments: { ids: ["n_a", "n_b"], name: "NPV", statement: "Net present value is the discounted sum of cash flows." } } }, tools);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(broker.pendingCount(entry.chatId), 1, "parked on the approval card");
		assert.equal(s.nodes.length, 3, "nothing written while the card is pending");
		assert.ok(broker.decide(entry.chatId, "ap-e2e", { approved }));
		const reply = (await pending) as { result: { content: Array<{ text: string }>; isError?: boolean } };
		toolOutput = reply.result.content[0]!.text;
		yield { type: "tool-end", id: "t1", output: toolOutput, isError: reply.result.isError === true } as const;
		yield { type: "text", delta: "Done." } as const;
	})();

	const chat = chats.create();
	const stream = startCliTurn({ chats, state, registry, broker, run }, chat.id, "merge the NPV nodes", "http://x");
	assert.ok(!("error" in stream));
	const text = await new Response(stream as ReadableStream<Uint8Array>).text();
	const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as CliWireEvent);
	return { s, ops, chats, chat, events, toolOutput };
}

describe("CLI chat end to end (fake CLI, real stack)", () => {
	it("merge via MCP: card -> approve -> graph merged -> assistant message persisted -> undo restores", async () => {
		const { s, ops, chats, chat, events } = await mergeTurn(true);
		assert.ok(events.some((e) => e.type === "approval"));
		assert.ok(events.some((e) => e.type === "approval-settled" && e.approved));
		assert.equal(s.nodes.length, 2);
		assert.ok(s.nodes.some((n) => n.id === "n_c"));
		assert.ok(!s.nodes.some((n) => n.id === "n_a" || n.id === "n_b"));
		const saved = chats.get(chat.id)!;
		assert.ok(saved.messages[1]!.parts.some((p) => p.type === "approval" && p.approval.status === "approved"));
		assert.ok(saved.messages[1]!.parts.some((p) => p.type === "tool" && p.call.status === "done"));
		assert.ok(ops.undoInfo());
		assert.ok(ops.undo().ok);
		assert.equal(s.nodes.length, 3);
	});

	it("merge via MCP: learner rejects -> graph unchanged, model told not to retry, no undo point", async () => {
		const { s, ops, chats, chat, events, toolOutput } = await mergeTurn(false);
		assert.ok(events.some((e) => e.type === "approval-settled" && !e.approved));
		assert.equal(s.nodes.length, 3);
		assert.match(toolOutput, /rejected/i);
		assert.match(toolOutput, /Do not retry/i);
		const saved = chats.get(chat.id)!;
		assert.ok(saved.messages[1]!.parts.some((p) => p.type === "approval" && p.approval.status === "rejected"));
		assert.equal(ops.undoInfo(), null);
	});
});
