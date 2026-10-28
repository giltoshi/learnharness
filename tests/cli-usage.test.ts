import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUsageStale, parseRateLimitEvent, resetLabel, usagePercent } from "../src/core/cli-usage.ts";

const event = {
	type: "rate_limit_event",
	rate_limit_info: {
		status: "allowed",
		unifiedWindows: {
			five_hour: { utilization: 0.12, resetsAt: 1793153400, status: "allowed" },
			seven_day: { utilization: 0.29, resetsAt: 1793170800, status: "allowed" },
		},
	},
};
const now = new Date("2026-10-27T12:00:00.000Z");

describe("parseRateLimitEvent", () => {
	it("reads both windows and stamps capturedAt", () => {
		const s = parseRateLimitEvent(event, now)!;
		assert.equal(s.fiveHour!.utilization, 0.12);
		assert.equal(s.sevenDay!.resetsAt, 1793170800);
		assert.equal(s.capturedAt, now.toISOString());
	});
	it("keeps a missing window as null", () => {
		const one = { ...event, rate_limit_info: { unifiedWindows: { five_hour: event.rate_limit_info.unifiedWindows.five_hour } } };
		const s = parseRateLimitEvent(one, now)!;
		assert.equal(s.sevenDay, null);
	});
	it("ignores a window with a non-numeric utilization", () => {
		const bad = { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: "x", resetsAt: 1, status: "a" } } } };
		assert.equal(parseRateLimitEvent(bad, now), null);
	});
	it("returns null for other line types and junk", () => {
		assert.equal(parseRateLimitEvent({ type: "assistant" }, now), null);
		assert.equal(parseRateLimitEvent(null, now), null);
		assert.equal(parseRateLimitEvent("x", now), null);
	});
});

describe("usage helpers", () => {
	it("usagePercent rounds the fraction", () => {
		assert.equal(usagePercent({ utilization: 0.285, resetsAt: 0, status: "" }), 29);
		assert.equal(usagePercent({ utilization: 0, resetsAt: 0, status: "" }), 0);
	});
	it("isUsageStale compares capturedAt to now (default 5 minutes)", () => {
		const s = parseRateLimitEvent(event, now)!;
		assert.equal(isUsageStale(s, now.getTime() + 4 * 60_000), false);
		assert.equal(isUsageStale(s, now.getTime() + 6 * 60_000), true);
	});
	it("resetLabel formats minutes, hours and days", () => {
		const at = (ms: number) => ({ utilization: 0, resetsAt: (now.getTime() + ms) / 1000, status: "" });
		assert.equal(resetLabel(at(45 * 60_000), now.getTime()), "resets in 45m");
		assert.equal(resetLabel(at(125 * 60_000), now.getTime()), "resets in 2h 05m");
		assert.equal(resetLabel(at(26 * 3_600_000), now.getTime()), "resets in 1d 2h");
		assert.equal(resetLabel(at(-1000), now.getTime()), "resetting");
	});
});
