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

/** Incremental NDJSON reader: buffers partial lines, skips (and reports) lines that are not valid JSON. */
export function createNdjsonParser(onEvent: (e: unknown) => void, onBadLine?: (line: string) => void): { push(chunk: string): void; end(): void } {
	let buf = "";
	const emit = (raw: string) => {
		const line = raw.trim();
		if (line === "") return;
		let parsed: unknown;
		try { parsed = JSON.parse(line); } catch { onBadLine?.(line); return; }
		onEvent(parsed);
	};
	return {
		push(chunk) {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				emit(line);
			}
		},
		end() {
			const rest = buf;
			buf = "";
			emit(rest);
		},
	};
}

/** Keep whichever usage snapshot was captured later (ISO strings compare lexically). */
export function pickNewerUsage<T extends { capturedAt: string }>(current: T | null, fetched: T | null): T | null {
	if (!fetched) return current;
	if (!current) return fetched;
	return fetched.capturedAt < current.capturedAt ? current : fetched;
}
