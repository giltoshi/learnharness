/**
 * One Claude CLI turn as a streamed NDJSON response. Responsibilities, in
 * order: refuse a busy/unknown chat; mint the per-turn MCP token; run the CLI;
 * fold every wire event into the assistant message with the SAME reducer the
 * browser uses; record plan-limit usage; and — in `finally`, however the turn
 * ends — persist, release the token, and reject any approval still parked.
 */
import { randomBytes } from "node:crypto";
import { applyWireEvent, newCliMessage } from "../core/cli-chat.ts";
import { DEFAULT_CLI_TITLE, type CliWireEvent } from "../core/contracts.ts";
import type { CliChatStore, CliStateStore } from "../core/ports.ts";
import type { CliRunEvent } from "../agent/cli/stream-map.ts";
import type { CliTool } from "../agent/cli/mcp-rpc.ts";
import type { ApprovalBroker } from "./cli-approvals.ts";

export interface TurnEntry {
	token: string;
	chatId: string;
	emit: (e: CliWireEvent) => void;
	tools?: CliTool[];
}

export function createTurnRegistry() {
	const byToken = new Map<string, TurnEntry>();
	const activeChats = new Set<string>();
	return {
		begin(chatId: string): TurnEntry | null {
			if (activeChats.has(chatId)) return null;
			const entry: TurnEntry = { token: randomBytes(18).toString("base64url"), chatId, emit: () => {} };
			activeChats.add(chatId);
			byToken.set(entry.token, entry);
			return entry;
		},
		get: (token: string) => byToken.get(token),
		end(token: string): void {
			const e = byToken.get(token);
			if (!e) return;
			byToken.delete(token);
			activeChats.delete(e.chatId);
		},
	};
}
export type TurnRegistry = ReturnType<typeof createTurnRegistry>;

export interface CliTurnDeps {
	chats: CliChatStore;
	state: CliStateStore;
	registry: TurnRegistry;
	broker: ApprovalBroker;
	run(o: { prompt: string; resume?: string; mcpUrl: string; signal: AbortSignal }): AsyncIterable<CliRunEvent>;
	now?: () => Date;
}

const ABORTED = Symbol("aborted");

export function startCliTurn(deps: CliTurnDeps, chatId: string, text: string, origin: string): ReadableStream<Uint8Array> | { error: "not_found" | "busy" } {
	const chat = deps.chats.get(chatId);
	if (!chat) return { error: "not_found" };
	const entry = deps.registry.begin(chatId);
	if (!entry) return { error: "busy" };

	const now = () => (deps.now ?? (() => new Date()))().toISOString();
	const stamp = Date.now().toString(36);
	const userMsg = newCliMessage("user", `${stamp}-u`, now(), text);
	let assistant = newCliMessage("assistant", `${stamp}-a`, now());
	let sessionId = chat.cliSessionId;
	const ac = new AbortController();
	const aborted = new Promise<typeof ABORTED>((resolve) => ac.signal.addEventListener("abort", () => resolve(ABORTED), { once: true }));
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (ev: CliWireEvent) => {
				assistant = applyWireEvent(assistant, ev);
				try { controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`)); } catch { /* client gone */ }
			};
			entry.emit = send;
			const iterator = deps.run({ prompt: text, resume: chat.cliSessionId, mcpUrl: `${origin}/api/cli/mcp/${entry.token}`, signal: ac.signal })[Symbol.asyncIterator]();
			try {
				for (;;) {
					// Race against the abort so a cancelled stream releases the chat
					// even if the runner is wedged and never yields again.
					const step = await Promise.race([iterator.next(), aborted]);
					if (step === ABORTED) break;
					if (step.done) break;
					const ev = step.value;
					if (ev.type === "session") { sessionId = ev.id; continue; }
					if (ev.type === "usage") deps.state.writeUsage(ev.usage);
					send(ev);
				}
			} catch (err) {
				send({ type: "error", message: err instanceof Error ? err.message : String(err) });
			} finally {
				void Promise.resolve(iterator.return?.()).catch(() => {});
				deps.broker.rejectAll(chatId);
				deps.registry.end(entry.token);
				deps.chats.save(chatId, { messages: [...chat.messages, userMsg, assistant], ...(sessionId ? { cliSessionId: sessionId } : {}) });
				if (chat.title === DEFAULT_CLI_TITLE) deps.chats.rename(chatId, text.trim().replace(/\s+/g, " ").slice(0, 60) || DEFAULT_CLI_TITLE);
				send({ type: "done" });
				try { controller.close(); } catch { /* already closed */ }
			}
		},
		cancel() { ac.abort(); },
	});
}
