import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createSdkMcpServer, query as sdkQuery, tool, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Api, AssistantMessage, ImageContent, Message, Model, SimpleStreamOptions, StopReason, StreamFunction, TextContent, Tool } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { PATHS } from "../../config.ts";

/**
 * CLAUDE SUBSCRIPTION ENGINE (spikes 2026-10-27): every model call runs
 * through the Claude Agent SDK, which spawns the local Claude Code CLI —
 * auth is whatever account `claude` → /login holds. No API key is read:
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped so a key saved
 * for the "anthropic" provider can never hijack the subscription.
 *
 * pi owns the agent loop, so Claude Code must only RELAY tool calls:
 * pi's tools are declared through an in-process MCP server, canUseTool
 * denies every call with interrupt, and the tool_use blocks stream out
 * un-executed (spike 1 — maxTurns does NOT stop execution).
 *
 * History (spike 2): NATIVE resume when the last assistant message was
 * produced here and the transcript before it is unchanged — rewind the
 * session to that message and answer with real tool_result blocks.
 * Otherwise FLATTEN the transcript into one prompt (first turn, restart,
 * compaction, edits, another provider's history).
 */

export const CLAUDE_CODE_PROVIDER = "claude-code";
const MCP_SERVER = "lh";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
const MAX_ANCHORS = 500;
/** The app's prompts name tools bare; Claude Code only exposes them prefixed, and rejects a bare call (live run 2026-10-27). */
const TOOL_PREFIX_NOTE = `Tool names: every tool is exposed as ${MCP_PREFIX}<name>. When these instructions name a tool (for example probe_done), call it as ${MCP_PREFIX}probe_done.`;

const ALIASES = [
	["opus", "Claude Opus (subscription)"],
	["sonnet", "Claude Sonnet (subscription)"],
	["haiku", "Claude Haiku (subscription)"],
] as const;

/** Aliases, not dated ids: Claude Code resolves each to its current model, so the picker never goes stale. */
export function claudeCodeModels(): Model<"anthropic-messages">[] {
	return ALIASES.map(([id, name]) => ({
		id, name, api: "anthropic-messages", provider: CLAUDE_CODE_PROVIDER, baseUrl: "",
		reasoning: true,
		// pi level → Claude Code effort; the CLI silently downgrades what a model can't do.
		thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		// Subscription usage is not billed per token.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	}));
}
export function claudeCodeModel(id: string): Model<"anthropic-messages"> | undefined { return claudeCodeModels().find((m) => m.id === id); }

// ── Native-resume bookkeeping (in memory by design: a restart costs one flattened turn per chat) ──

interface Anchor { sessionId: string; uuid: string; prefix: string }
const anchors = new Map<string, Anchor>();
function remember(key: string, anchor: Anchor): void {
	anchors.delete(key); anchors.set(key, anchor);
	if (anchors.size > MAX_ANCHORS) anchors.delete(anchors.keys().next().value!);
}
/** Test seam. */
export function resetClaudeCodeSessions(): void { anchors.clear(); }

/** Only fields that survive the record round-trip (text, call ids, result ids) — thinking, images and timestamps don't. */
function stable(message: Message): unknown {
	if (message.role === "toolResult") return ["toolResult", message.toolCallId, texts(message.content)];
	if (message.role === "assistant") return ["assistant", message.content.flatMap((b) => b.type === "text" ? [b.text] : b.type === "toolCall" ? [`call:${b.id}`] : [])];
	if (message.role === "user") return ["user", typeof message.content === "string" ? message.content : texts(message.content)];
	return null;
}
function fingerprint(messages: Message[]): string {
	return createHash("sha256").update(JSON.stringify(messages.filter((m) => m.role !== "system").map(stable))).digest("hex");
}
function anchorKey(message: AssistantMessage): string { return fingerprint([message]); }
function texts(content: (TextContent | ImageContent)[]): string { return content.map((b) => b.type === "text" ? b.text : "[image]").join("\n"); }

// ── Content conversion ──

type Block = Record<string, unknown>;
function blocks(content: string | (TextContent | ImageContent)[]): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((b) => b.type === "text" ? { type: "text", text: b.text } : { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
}
function userMessage(content: Block[]): SDKUserMessage {
	return { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } } as unknown as SDKUserMessage;
}
async function* once(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> { yield message; }

/** The tail after the anchor as ONE user turn — tool_results first, as the Messages API requires. */
function tailMessage(tail: Message[]): SDKUserMessage | undefined {
	const results: Block[] = [], rest: Block[] = [];
	for (const m of tail) {
		if (m.role === "toolResult") results.push({ type: "tool_result", tool_use_id: m.toolCallId, content: blocks(m.content), is_error: m.isError });
		else if (m.role === "user") rest.push(...blocks(m.content));
		else if (m.role !== "system") return undefined;
	}
	return results.length + rest.length ? userMessage([...results, ...rest]) : undefined;
}

function flatten(messages: Message[]): SDKUserMessage {
	const turns = messages.filter((m) => m.role !== "system");
	const only = turns.length === 1 ? turns[0] : undefined;
	if (only?.role === "user") return userMessage(blocks(only.content));
	const out: Block[] = [{ type: "text", text: "<transcript>" }];
	const say = (text: string) => out.push({ type: "text", text });
	for (const m of turns) {
		if (m.role === "user") { say("[user]"); out.push(...blocks(m.content)); }
		else if (m.role === "toolResult") { say(`[tool result: ${m.toolName}${m.isError ? " (error)" : ""}]`); out.push(...blocks(m.content)); }
		else if (m.role === "assistant") for (const b of m.content) {
			if (b.type === "text") say(`[assistant]\n${b.text}`);
			else if (b.type === "toolCall") say(`[assistant called ${b.name}] ${JSON.stringify(b.arguments)}`);
		}
	}
	say("</transcript>\nYou are the assistant in this transcript. Continue it from where it ends, using the tools as needed.");
	return userMessage(out);
}

// ── Tools: declared to Claude Code, never executed by it ──

function zodShape(parameters: unknown): Record<string, z.ZodType> {
	const schema = JSON.parse(JSON.stringify(parameters ?? {})) as { properties?: Record<string, unknown>; required?: string[] };
	const required = new Set(schema.required ?? []);
	return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, prop]) => {
		let type: z.ZodType;
		try { type = z.fromJSONSchema(prop as Parameters<typeof z.fromJSONSchema>[0]); } catch { type = z.any(); }
		return [name, required.has(name) ? type : type.optional()];
	}));
}
/** Claude sometimes sends a nested object/array argument as its JSON text (live run 2026-10-27): parse it back when the schema expects one. */
export function coerceArguments(args: Record<string, unknown>, parameters: unknown): Record<string, unknown> {
	const props = (parameters as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties ?? {};
	const out = { ...args };
	for (const [name, value] of Object.entries(out)) {
		const type = props[name]?.type;
		if (typeof value !== "string" || (type !== "object" && type !== "array")) continue;
		try {
			const parsed: unknown = JSON.parse(value);
			if (type === "array" ? Array.isArray(parsed) : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) out[name] = parsed;
		} catch { /* not JSON: leave it for pi's validation to report */ }
	}
	return out;
}
function toolServer(tools: Tool[]): NonNullable<Options["mcpServers"]> {
	if (!tools.length) return {};
	return { [MCP_SERVER]: createSdkMcpServer({ name: MCP_SERVER, version: "1.0.0", tools: tools.map((t) => tool(t.name, t.description, zodShape(t.parameters),
		async () => ({ content: [{ type: "text", text: "This tool is executed by the host app, not here." }], isError: true }))) }) };
}

// ── Errors ──

export function claudeCodeError(message: string): string {
	const suffix = " No API-key fallback was used.";
	if (/authentication|401|login|oauth|credential/i.test(message)) return `Claude sign-in failed. Run \`claude\` in a terminal, use /login, then retry.${suffix}`;
	if (/rate.?limit|429|usage limit|quota/i.test(message)) return `Claude subscription usage limit reached. Try again later.${suffix}`;
	if (/ENOENT|spawn|executable|not found/i.test(message)) return `Claude Code could not start. Check that it is installed and runs from a terminal.${suffix}`;
	if (/abort|cancel|interrupt/i.test(message)) return `Claude request cancelled.${suffix}`;
	return `Claude request failed: ${message.slice(0, 200)}${suffix}`;
}

// ── The stream ──

type RawEvent = { type: string; index?: number; message?: { id?: string; usage?: Record<string, number> }; content_block?: Record<string, any>; delta?: Record<string, any>; usage?: Record<string, number> };
const STOP: Record<string, Extract<StopReason, "stop" | "length" | "toolUse">> = { tool_use: "toolUse", max_tokens: "length", end_turn: "stop", stop_sequence: "stop", refusal: "stop", pause_turn: "stop" };

export type ClaudeCodeQuery = typeof sdkQuery;

/** `run` is the test seam; production uses the SDK's query(). */
export function claudeCodeStream(run: ClaudeCodeQuery = sdkQuery): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		void (async () => {
			const messages = context.messages;
			const last = messages.findLastIndex((m) => m.role === "assistant");
			const anchor = last >= 0 ? anchors.get(anchorKey(messages[last] as AssistantMessage)) : undefined;
			const native = anchor && anchor.prefix === fingerprint(messages.slice(0, last)) ? tailMessage(messages.slice(last + 1)) : undefined;
			const prompt = native ?? flatten(messages);

			const env: Record<string, string | undefined> = { ...process.env };
			delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
			const cwd = path.join(PATHS.data, "claude-code");
			mkdirSync(cwd, { recursive: true });
			const level = options?.reasoning;
			const tools = getCurrentTools(messages);
			const systemPrompt = getCurrentSystemPrompt(messages);
			const sdkOptions: Options = {
				model: model.id, cwd, env, abortController: abort,
				systemPrompt: tools.length ? `${systemPrompt}\n\n${TOOL_PREFIX_NOTE}` : systemPrompt,
				tools: [], settingSources: [], strictMcpConfig: true,
				mcpServers: toolServer(tools),
				includePartialMessages: true, persistSession: true, maxTurns: 3,
				...(level ? { effort: level as Options["effort"] } : { thinking: { type: "disabled" } }),
				...(native && anchor ? { resume: anchor.sessionId, resumeSessionAt: anchor.uuid, forkSession: true } : {}),
				canUseTool: async () => ({ behavior: "deny", message: "Relayed to the host app; do not retry.", interrupt: true }),
			};

			// One API response only: Claude Code's own follow-up turns are never relayed.
			let apiMessageId: string | undefined, sessionId: string | undefined, lastUuid: string | undefined;
			let started = false, finished = false, open = 0, failure: string | undefined;
			const slot = new Map<number, number>();
			const start = () => { if (!started) { started = true; output.push({ type: "start", partial: message }); } };
			const usage = (u?: Record<string, number>) => {
				if (!u) return;
				const t = message.usage;
				if (u.input_tokens !== undefined) t.input = u.input_tokens;
				if (u.cache_read_input_tokens !== undefined) t.cacheRead = u.cache_read_input_tokens;
				if (u.cache_creation_input_tokens !== undefined) t.cacheWrite = u.cache_creation_input_tokens;
				if (u.output_tokens !== undefined) t.output = u.output_tokens;
				t.totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite;
			};
			const raw = (e: RawEvent) => {
				if (finished) return;
				if (e.type === "message_start") {
					if (apiMessageId) { finished = true; return; } // a second response means the first one is over
					apiMessageId = e.message?.id; usage(e.message?.usage); start(); return;
				}
				if (e.type === "message_delta") { usage(e.usage); if (e.delta?.stop_reason) message.stopReason = STOP[e.delta.stop_reason] ?? "stop"; return; }
				if (e.type === "message_stop") { finished = true; return; }
				const index = e.index ?? 0;
				if (e.type === "content_block_start") {
					const b = e.content_block ?? {};
					const at = message.content.length;
					if (b.type === "text") { message.content.push({ type: "text", text: "" }); output.push({ type: "text_start", contentIndex: at, partial: message }); }
					else if (b.type === "thinking") { message.content.push({ type: "thinking", thinking: "" }); output.push({ type: "thinking_start", contentIndex: at, partial: message }); }
					else if (b.type === "redacted_thinking") { message.content.push({ type: "thinking", thinking: "", redacted: true, thinkingSignature: b.data }); output.push({ type: "thinking_start", contentIndex: at, partial: message }); }
					else if (b.type === "tool_use") {
						const name = String(b.name ?? "").startsWith(MCP_PREFIX) ? String(b.name).slice(MCP_PREFIX.length) : String(b.name ?? "");
						message.content.push({ type: "toolCall", id: b.id, name, arguments: {}, partialJson: "" } as AssistantMessage["content"][number]);
						output.push({ type: "toolcall_start", contentIndex: at, partial: message });
					} else return;
					slot.set(index, at); open++; return;
				}
				const at = slot.get(index);
				if (at === undefined) return;
				const block = message.content[at] as Record<string, any>;
				if (e.type === "content_block_delta") {
					const d = e.delta ?? {};
					if (d.type === "text_delta") { block.text += d.text; output.push({ type: "text_delta", contentIndex: at, delta: d.text, partial: message }); }
					else if (d.type === "thinking_delta") { block.thinking += d.thinking; output.push({ type: "thinking_delta", contentIndex: at, delta: d.thinking, partial: message }); }
					else if (d.type === "signature_delta") block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
					else if (d.type === "input_json_delta") { block.partialJson += d.partial_json; output.push({ type: "toolcall_delta", contentIndex: at, delta: d.partial_json, partial: message }); }
				} else if (e.type === "content_block_stop") {
					open--;
					if (block.type === "text") output.push({ type: "text_end", contentIndex: at, content: block.text, partial: message });
					else if (block.type === "thinking") output.push({ type: "thinking_end", contentIndex: at, content: block.thinking, partial: message });
					else if (block.type === "toolCall") {
						try { block.arguments = coerceArguments(block.partialJson ? JSON.parse(block.partialJson) : {}, tools.find((t) => t.name === block.name)?.parameters); }
						catch { block.arguments = {}; block.argumentsError = `Arguments were not valid JSON: ${String(block.partialJson).slice(0, 200)}`; }
						delete block.partialJson;
						output.push({ type: "toolcall_end", contentIndex: at, toolCall: block as never, partial: message });
					}
				}
			};

			try {
				for await (const m of run({ prompt: once(prompt), options: sdkOptions }) as AsyncIterable<SDKMessage>) {
					sessionId ??= (m as { session_id?: string }).session_id || undefined;
					if (m.type === "stream_event" && !m.parent_tool_use_id) raw(m.event as RawEvent);
					else if (m.type === "assistant" && !m.parent_tool_use_id) {
						if ((m as { error?: string }).error) failure = `${(m as { error?: string }).error}: ${m.message.content.map((b) => b.type === "text" ? b.text : "").join(" ")}`;
						else if (m.message.id === apiMessageId) lastUuid = m.uuid;
					}
				}
			} catch (error) {
				// deny+interrupt always ends in a thrown error result, and can land BEFORE message_delta /
				// message_stop: every block that started has ended → the response is complete.
				if (!finished && !(open === 0 && message.content.length > 0)) failure ??= error instanceof Error ? error.message : String(error);
			} finally { options?.signal?.removeEventListener("abort", onAbort); }
			if (!finished && open === 0 && message.content.length > 0 && !failure) finished = true;
			// pi runs tools only on toolUse; the stop reason can be lost to the interrupt, the calls cannot.
			if (message.content.some((b) => b.type === "toolCall")) message.stopReason = "toolUse";

			if (failure || !finished || abort.signal.aborted) {
				const aborted = abort.signal.aborted && !finished;
				const error = { ...message, stopReason: aborted ? "aborted" as const : "error" as const, errorMessage: claudeCodeError(failure ?? (aborted ? "aborted" : "Claude Code ended without a response")) };
				start(); output.push({ type: "error", reason: error.stopReason, error }); output.end(); return;
			}
			if (sessionId && lastUuid) remember(anchorKey(message), { sessionId, uuid: lastUuid, prefix: fingerprint(messages) });
			output.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message }); output.end();
		})();
		return output;
	};
}
