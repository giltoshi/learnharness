/**
 * Claude CLI stream-json → the app's wire vocabulary. With
 * --include-partial-messages the text arrives as stream_event deltas AND again
 * inside the final `assistant` message, so text is taken from deltas for any
 * message that streamed and from the `assistant` line only otherwise. Tool
 * calls come from `assistant` tool_use blocks, results from `user` tool_result
 * blocks. Unknown lines are ignored: the CLI protocol is an adapter concern
 * and must never crash a turn.
 */
import { MCP_SERVER_NAME } from "./args.ts";
import { parseRateLimitEvent } from "../../core/cli-usage.ts";
import type { CliWireEvent } from "../../core/contracts/cli.ts";

export type CliRunEvent = CliWireEvent | { type: "session"; id: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
	}
	return "";
}

export function createStreamMapper(now: () => Date = () => new Date()) {
	let sessionSent = false;
	const streamed = new Set<string>();

	function push(line: unknown): CliRunEvent[] {
		if (!isRecord(line)) return [];
		const out: CliRunEvent[] = [];

		if (!sessionSent && typeof line.session_id === "string") {
			sessionSent = true;
			out.push({ type: "session", id: line.session_id });
		}

		switch (line.type) {
			case "stream_event": {
				const ev = line.event;
				if (!isRecord(ev)) break;
				if (ev.type === "message_start" && isRecord(ev.message) && typeof ev.message.id === "string") streamed.add(ev.message.id);
				if (ev.type === "content_block_delta" && isRecord(ev.delta) && ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
					out.push({ type: "text", delta: ev.delta.text });
				}
				break;
			}
			case "assistant": {
				const msg = line.message;
				if (!isRecord(msg) || !Array.isArray(msg.content)) break;
				const wasStreamed = typeof msg.id === "string" && streamed.has(msg.id);
				for (const block of msg.content) {
					if (!isRecord(block)) continue;
					if (block.type === "text" && typeof block.text === "string" && !wasStreamed) out.push({ type: "text", delta: block.text });
					if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
						out.push({ type: "tool-start", id: block.id, name: block.name.startsWith(PREFIX) ? block.name.slice(PREFIX.length) : block.name, input: block.input });
					}
				}
				break;
			}
			case "user": {
				const msg = line.message;
				if (!isRecord(msg) || !Array.isArray(msg.content)) break;
				for (const block of msg.content) {
					if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
						out.push({ type: "tool-end", id: block.tool_use_id, output: resultText(block.content), isError: block.is_error === true });
					}
				}
				break;
			}
			case "rate_limit_event": {
				const usage = parseRateLimitEvent(line, now());
				if (usage) out.push({ type: "usage", usage });
				break;
			}
			case "result": {
				if (line.is_error === true) out.push({ type: "error", message: typeof line.result === "string" && line.result !== "" ? line.result : "The Claude CLI reported an error" });
				break;
			}
		}
		return out;
	}
	return { push };
}
