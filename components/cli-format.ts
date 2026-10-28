/** Pure formatting for the CLI chat UI. */
import type { CliToolCall } from "@/src/core";

export function toolSummary(call: CliToolCall): string {
	const input = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {};
	const ids = Array.isArray(input.ids) ? ` ${input.ids.length} id${input.ids.length === 1 ? "" : "s"}` : "";
	const q = typeof input.query === "string" ? ` “${input.query}”` : "";
	return `${call.name}${ids}${q}`;
}

export function timeOfDay(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
