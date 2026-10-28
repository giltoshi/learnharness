/**
 * Plan-limit usage helpers (Claude CLI rate_limit_event). Pure, browser-safe.
 * The CLI reports utilization as a 0..1 fraction per window.
 */
import type { UsageSnapshot, UsageWindow } from "./contracts/cli.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function readWindow(v: unknown): UsageWindow | null {
	if (!isRecord(v)) return null;
	if (typeof v.utilization !== "number" || !Number.isFinite(v.utilization)) return null;
	if (typeof v.resetsAt !== "number" || !Number.isFinite(v.resetsAt)) return null;
	return { utilization: v.utilization, resetsAt: v.resetsAt, status: typeof v.status === "string" ? v.status : "" };
}

/** A rate_limit_event stream line → snapshot; null when it isn't one or carries no usable window. */
export function parseRateLimitEvent(raw: unknown, now: Date = new Date()): UsageSnapshot | null {
	if (!isRecord(raw) || raw.type !== "rate_limit_event" || !isRecord(raw.rate_limit_info)) return null;
	const windows = raw.rate_limit_info.unifiedWindows;
	if (!isRecord(windows)) return null;
	const fiveHour = readWindow(windows.five_hour);
	const sevenDay = readWindow(windows.seven_day);
	if (fiveHour === null && sevenDay === null) return null;
	return { fiveHour, sevenDay, capturedAt: now.toISOString() };
}

export function isUsageStale(s: UsageSnapshot, nowMs: number, maxAgeMs = 5 * 60_000): boolean {
	return nowMs - Date.parse(s.capturedAt) > maxAgeMs;
}

export function usagePercent(w: UsageWindow): number {
	// toFixed strips float noise (0.285 * 100 === 28.499999999999996) so exact .5 rounds up.
	return Math.round(Number((w.utilization * 100).toFixed(6)));
}

export function resetLabel(w: UsageWindow, nowMs: number): string {
	const ms = w.resetsAt * 1000 - nowMs;
	if (ms <= 0) return "resetting";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `resets in ${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
	return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
