import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";

process.env.LH_DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), "lh-claude-code-"));
const { claudeCodeModel, claudeCodeStream, resetClaudeCodeSessions } = await import("../src/agent/claude-code-stream.ts");

// A scripted stand-in for the SDK's query(): records each call and replays SDK messages.
interface Call { prompt: any[]; options: any }
let calls: Call[] = [];
let script: (call: Call) => unknown[] = () => [];
let throwAfter: string | undefined;
const fakeQuery = ((args: { prompt: AsyncIterable<unknown>; options: any }) => (async function* () {
	const call: Call = { prompt: [], options: args.options };
	for await (const m of args.prompt) call.prompt.push(m);
	calls.push(call);
	for (const m of script(call)) yield m;
	if (throwAfter) throw new Error(throwAfter);
})()) as never;

const SESSION = "11111111-1111-1111-1111-111111111111";
const model = claudeCodeModel("haiku")!;
const ask = { name: "ask_learner", description: "Ask a question.", parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }) };

/** One API response that ends in a relayed tool_use, as Claude Code streams it with deny+interrupt. */
function toolTurn(id: string, uuid: string, args: object): unknown[] {
	const ev = (event: object) => ({ type: "stream_event", event, parent_tool_use_id: null, session_id: SESSION, uuid: "x" });
	const json = JSON.stringify(args);
	return [
		{ type: "system", subtype: "init", session_id: SESSION },
		ev({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, output_tokens: 1 } } }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let's check." } }),
		ev({ type: "content_block_stop", index: 0 }),
		ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: "mcp__lh__ask_learner", input: {} } }),
		ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 10) } }),
		ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(10) } }),
		ev({ type: "content_block_stop", index: 1 }),
		{ type: "assistant", parent_tool_use_id: null, session_id: SESSION, uuid: `${uuid}-a`, message: { id: "msg_1", content: [{ type: "text", text: "Let's check." }] } },
		{ type: "assistant", parent_tool_use_id: null, session_id: SESSION, uuid, message: { id: "msg_1", content: [{ type: "tool_use", id, name: "mcp__lh__ask_learner", input: args }] } },
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }),
		ev({ type: "message_stop" }),
	];
}

async function run(messages: Message[], reasoning?: string) {
	const events: AssistantMessageEvent[] = [];
	const stream = claudeCodeStream(fakeQuery)(model, normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [ask] }), reasoning ? { reasoning: reasoning as never } : {});
	for await (const e of stream) events.push(e);
	return events;
}
const final = (events: AssistantMessageEvent[]) => {
	const last = events.at(-1)!;
	assert.equal(last.type, "done", JSON.stringify(last));
	return (last as { message: AssistantMessage }).message;
};
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const result = (toolCallId: string, text: string): Message => ({ role: "toolResult", toolCallId, toolName: "ask_learner", content: [{ type: "text", text }], isError: false, timestamp: 2 });

beforeEach(() => { calls = []; script = () => []; throwAfter = undefined; resetClaudeCodeSessions(); });

test("relays a tool_use un-executed, on the subscription, with Claude Code's own tools and settings off", async () => {
	process.env.ANTHROPIC_API_KEY = "sk-ant-must-never-be-used";
	script = () => toolTurn("toolu_1", "uuid-1", { question: "P/E of $60 / $3?", options: ["10", "20"] });
	throwAfter = "Claude Code returned an error result: interrupted"; // what deny+interrupt always ends in
	const message = final(await run([user("Quiz me on P/E.")]));
	delete process.env.ANTHROPIC_API_KEY;

	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content, [
		{ type: "text", text: "Let's check." },
		{ type: "toolCall", id: "toolu_1", name: "ask_learner", arguments: { question: "P/E of $60 / $3?", options: ["10", "20"] } },
	]);
	assert.deepEqual([message.usage.input, message.usage.cacheRead, message.usage.cacheWrite, message.usage.output], [5, 100, 7, 42]);
	assert.equal(message.usage.cost.total, 0);

	const { options, prompt } = calls[0]!;
	assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
	assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
	assert.deepEqual(options.tools, []);
	assert.deepEqual(options.settingSources, []);
	assert.equal(options.strictMcpConfig, true);
	assert.equal(options.systemPrompt, "You are a tutor.");
	assert.equal(options.resume, undefined);
	assert.deepEqual(options.thinking, { type: "disabled" });
	assert.deepEqual(await options.canUseTool("mcp__lh__ask_learner", {}), { behavior: "deny", message: "Relayed to the host app; do not retry.", interrupt: true });
	assert.deepEqual(prompt[0].message.content, [{ type: "text", text: "Quiz me on P/E." }]);
});

test("next call resumes natively at the tool_use message and answers with a real tool_result", async () => {
	script = () => toolTurn("toolu_1", "uuid-1", { question: "Q1" });
	const first = final(await run([user("Quiz me.")]));
	script = () => toolTurn("toolu_2", "uuid-2", { question: "Q2" });
	final(await run([user("Quiz me."), first, result("toolu_1", "Chose 30.")], "high"));

	const { options, prompt } = calls[1]!;
	assert.equal(options.resume, SESSION);
	assert.equal(options.resumeSessionAt, "uuid-1", "the LAST chain entry of the anchor response");
	assert.equal(options.forkSession, true);
	assert.equal(options.effort, "high");
	assert.deepEqual(prompt[0].message.content, [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Chose 30." }], is_error: false }]);
});

test("native resume survives the record round-trip (thinking dropped, timestamps changed)", async () => {
	script = () => toolTurn("toolu_1", "uuid-1", { question: "Q1" });
	const first = final(await run([user("Quiz me.")]));
	const rebuilt: AssistantMessage = { ...first, timestamp: 999, content: [{ type: "thinking", thinking: "" }, ...first.content] };
	final(await run([{ ...user("Quiz me."), timestamp: 5 }, rebuilt, result("toolu_1", "Chose 30.")]));
	assert.equal(calls[1]!.options.resume, SESSION);
});

test("a rewritten history (compaction, edit) falls back to a flattened transcript", async () => {
	script = () => toolTurn("toolu_1", "uuid-1", { question: "Q1" });
	const first = final(await run([user("Quiz me.")]));
	final(await run([user("Quiz me on P/E ratios, please."), first, result("toolu_1", "Chose 30.")]));

	const { options, prompt } = calls[1]!;
	assert.equal(options.resume, undefined);
	const text = prompt[0].message.content.map((b: { text?: string }) => b.text ?? "").join("\n");
	assert.match(text, /<transcript>/);
	assert.match(text, /\[assistant called ask_learner\] \{"question":"Q1"\}/);
	assert.match(text, /\[tool result: ask_learner\]\nChose 30\./);
});

test("history from another provider flattens", async () => {
	script = () => toolTurn("toolu_9", "uuid-9", { question: "Q" });
	const foreign: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5", content: [{ type: "text", text: "Hi." }], stopReason: "stop", timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	final(await run([user("Hello"), foreign, user("Quiz me.")]));
	assert.equal(calls[0]!.options.resume, undefined);
	assert.match(JSON.stringify(calls[0]!.prompt[0].message.content), /\[assistant\]\\nHi\./);
});

test("a sign-in failure surfaces as an error event, never a silent API-key fallback", async () => {
	script = () => [
		{ type: "system", subtype: "init", session_id: SESSION },
		{ type: "assistant", parent_tool_use_id: null, session_id: SESSION, uuid: "u", error: "authentication_failed", message: { id: "x", model: "<synthetic>", content: [{ type: "text", text: "Invalid API key · Please run /login" }] } },
	];
	throwAfter = "Claude Code returned an error result";
	const events = await run([user("Hi")]);
	const last = events.at(-1)!;
	assert.equal(last.type, "error");
	assert.match((last as { error: AssistantMessage }).error.errorMessage!, /Claude sign-in failed.*No API-key fallback was used\./);
});

test("an interrupt that lands before message_delta/message_stop still yields a complete toolUse response", async () => {
	script = () => toolTurn("toolu_1", "uuid-1", { question: "Q" }).slice(0, -2); // live smoke 2026-10-27: no stop_reason arrived
	throwAfter = "Claude Code returned an error result: interrupted";
	const message = final(await run([user("Hi")]));
	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content.at(-1), { type: "toolCall", id: "toolu_1", name: "ask_learner", arguments: { question: "Q" } });
});

test("an interrupt mid-block is a failure, not a truncated success", async () => {
	script = () => toolTurn("toolu_1", "uuid-1", { question: "Q" }).slice(0, 8); // tool_use block never stops
	throwAfter = "Claude Code returned an error result: interrupted";
	const last = (await run([user("Hi")])).at(-1)!;
	assert.equal(last.type, "error");
});

test("streams text deltas as they arrive", async () => {
	script = () => toolTurn("toolu_1", "uuid-1", { question: "Q" });
	const types = (await run([user("Hi")])).map((e) => e.type);
	assert.deepEqual(types, ["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
});
