import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNdjsonParser, pickNewerUsage } from "../components/cli-format.ts";

const collect = () => {
	const events: unknown[] = [];
	const bad: string[] = [];
	const p = createNdjsonParser((e) => events.push(e), (l) => bad.push(l));
	return { events, bad, p };
};

describe("createNdjsonParser", () => {
	it("buffers a partial line across chunks", () => {
		const { events, p } = collect();
		p.push('{"a":'); assert.equal(events.length, 0);
		p.push("1}\n"); assert.deepEqual(events, [{ a: 1 }]);
	});
	it("handles multiple lines per chunk", () => {
		const { events, p } = collect();
		p.push('{"a":1}\n{"b":2}\n{"c":'); p.push("3}\n");
		assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
	});
	it("end() flushes a final line without newline", () => {
		const { events, p } = collect();
		p.push('{"a":1}'); assert.equal(events.length, 0);
		p.end(); assert.deepEqual(events, [{ a: 1 }]);
	});
	it("skips and reports bad lines while later lines still parse", () => {
		const { events, bad, p } = collect();
		p.push('{"a":1}\nnot json\n{"b":2}\n');
		assert.deepEqual(events, [{ a: 1 }, { b: 2 }]); assert.deepEqual(bad, ["not json"]);
	});
	it("ignores blank lines", () => {
		const { events, bad, p } = collect();
		p.push('\n  \n{"a":1}\r\n\n'); p.end();
		assert.deepEqual(events, [{ a: 1 }]); assert.deepEqual(bad, []);
	});
});

describe("pickNewerUsage", () => {
	const u = (capturedAt: string) => ({ capturedAt }) as never;
	it("keeps current when fetched is older, takes fetched when newer or no current", () => {
		const a = u("2026-10-27T12:00:00.000Z"), b = u("2026-10-27T12:05:00.000Z");
		assert.equal(pickNewerUsage(b, a), b);
		assert.equal(pickNewerUsage(a, b), b);
		assert.equal(pickNewerUsage(null, a), a);
		assert.equal(pickNewerUsage(a, null), a);
	});
});
