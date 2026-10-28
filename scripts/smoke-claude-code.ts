/**
 * Live smoke for the Claude subscription engine (uses YOUR `claude` login,
 * spends a little subscription usage on haiku). Two turns:
 *   1. a fresh question → expect one relayed ask_learner call, un-executed
 *   2. the learner's wrong answer as a tool_result → expect NATIVE resume and a graded follow-up
 *
 *   npx tsx scripts/smoke-claude-code.ts
 */
import { normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { claudeCodeModel, claudeCodeStream } from "../src/agent/claude-code-stream.ts";

const resumes: (string | undefined)[] = [];
const recording = ((args: Parameters<typeof query>[0]) => {
	resumes.push(args.options?.resumeSessionAt);
	const t0 = Date.now(), seen = new Set<string>(), inner = query(args);
	// Phase timing: process up (init) → first model token → done.
	return (async function* () {
		for await (const m of inner) {
			const phase = m.type === "system" ? `init:${(m as { subtype?: string }).subtype}` : m.type === "stream_event" ? "first stream event" : "";
			if (phase && !seen.has(phase)) { seen.add(phase); console.log(`    +${Date.now() - t0}ms ${phase}`); }
			yield m;
		}
	})();
}) as typeof query;
const stream = claudeCodeStream(recording);
const model = claudeCodeModel("haiku")!;
const ask = { name: "ask_learner", description: "Ask the learner a multiple-choice question.", parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }) };
const system = `You are a tutor. Every reply is exactly one ask_learner call. Grade the learner's previous answer inside the next question's text.
Your FIRST question must be exactly: "A stock trades at $60 and its EPS is $3. What is its P/E ratio?" with options ["10","20","30","180"].`;

async function turn(messages: Message[]): Promise<AssistantMessage> {
	const t0 = Date.now();
	for await (const e of stream(model, normalizeContext({ systemPrompt: system, messages, tools: [ask] }), {})) {
		if (e.type === "error") throw new Error(e.error.errorMessage);
		if (e.type === "done") { console.log(`  ${Date.now() - t0}ms, stop=${e.reason}, usage in=${e.message.usage.input} cacheRead=${e.message.usage.cacheRead} out=${e.message.usage.output}`); return e.message; }
	}
	throw new Error("stream ended without done");
}
const call = (m: AssistantMessage) => m.content.find((b) => b.type === "toolCall");

const history: Message[] = [{ role: "user", content: "Quiz me on P/E ratios.", timestamp: Date.now() }];
console.log("turn 1");
const first = await turn(history);
const c1 = call(first);
console.log(`  ${c1 ? `${c1.name} ${JSON.stringify(c1.arguments)}` : "NO TOOL CALL"}`);
if (!c1) process.exit(1);

history.push(first, { role: "toolResult", toolCallId: c1.id, toolName: c1.name, content: [{ type: "text", text: `Chose "30". Thinking: (60-3)/2 is about 30.` }], isError: false, timestamp: Date.now() });
console.log("turn 2");
const second = await turn(history);
const c2 = call(second);
console.log(`  ${c2 ? `${c2.name} ${JSON.stringify(c2.arguments)}` : "NO TOOL CALL"}`);
console.log(`\nresumeSessionAt per turn: ${JSON.stringify(resumes)}  →  turn 2 ${resumes[1] ? "NATIVE" : "FLATTENED"}`);
