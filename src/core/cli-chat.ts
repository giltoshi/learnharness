/**
 * CLI chat message building — ONE pure reducer shared by the server (to
 * persist a turn) and the browser (to render it live), so the two can never
 * disagree about what a stream means.
 */
import type { CliMessage, CliPart, CliWireEvent } from "./contracts/cli.ts";

export function newCliMessage(role: CliMessage["role"], id: string, createdAt: string, text?: string): CliMessage {
	return { id, role, createdAt, parts: text === undefined ? [] : [{ type: "text", text }] };
}

export function applyWireEvent(msg: CliMessage, ev: CliWireEvent): CliMessage {
	const parts = msg.parts;
	switch (ev.type) {
		case "text": {
			const last = parts[parts.length - 1];
			if (last?.type === "text") {
				return { ...msg, parts: [...parts.slice(0, -1), { type: "text", text: last.text + ev.delta }] };
			}
			return { ...msg, parts: [...parts, { type: "text", text: ev.delta }] };
		}
		case "tool-start":
			return { ...msg, parts: [...parts, { type: "tool", call: { id: ev.id, name: ev.name, input: ev.input, status: "running" } }] };
		case "tool-end":
			return {
				...msg,
				parts: parts.map(
					(p): CliPart =>
						p.type === "tool" && p.call.id === ev.id
							? { type: "tool", call: { ...p.call, status: ev.isError ? "error" : "done", output: ev.output } }
							: p,
				),
			};
		case "approval":
			return { ...msg, parts: [...parts, { type: "approval", approval: ev.approval }] };
		case "approval-settled":
			return {
				...msg,
				parts: parts.map(
					(p): CliPart =>
						p.type === "approval" && p.approval.id === ev.id
							? { type: "approval", approval: { ...p.approval, status: ev.approved ? "approved" : "rejected" } }
							: p,
				),
			};
		case "error":
			return { ...msg, parts: [...parts, { type: "error", message: ev.message }] };
		case "usage":
		case "done":
			return msg;
	}
}
