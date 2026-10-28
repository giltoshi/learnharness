/**
 * Legend/filters predicate tests — the pure half of the graph-view filters
 * panel (isNodeVisible); the sigma reducers just consume its verdict.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commitPayload, displayCostTotals, isNodeVisible } from "../components/graph-view.tsx";

const node = {
	name: "Money multiplier",
	statement: "The maximum ratio of broad money a bank can create from each unit of base money.",
};

describe("isNodeVisible (search predicate)", () => {
	it("is visible with an empty query", () => {
		assert.equal(isNodeVisible(node, ""), true);
	});

	it("search matches the statement case-insensitively", () => {
		assert.equal(isNodeVisible(node, "MONEY multiplier"), true);
	});

	it("search matches the statement when the name does not", () => {
		assert.equal(isNodeVisible(node, "MAXIMUM ratio"), true);
		assert.equal(isNodeVisible(node, " velocity"), false);
	});

	it("search matches the name when the statement does not", () => {
		assert.equal(isNodeVisible(node, "money MULTIPLIER"), true);
		assert.equal(isNodeVisible(node, " banking"), false);
	});

	it("whitespace-only query is no filter", () => {
		assert.equal(isNodeVisible(node, "   "), true);
	});


});

describe("displayCostTotals (naming-free cost fold)", () => {
	const stage = (dollars: number, unpricedRuns = 0) => ({
		runs: dollars > 0 ? 1 : 0,
		dollars,
		unpricedRuns,
		tokens: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		},
	});
	const costs = {
		stages: {
			extraction: stage(1.25, 1),
			audit: stage(0.75),
			naming: stage(9.99, 2), // dead channel — must never reach the display
		},
	} as const;

	it("sums the live stages only — the dead namer's spend is invisible", () => {
		assert.equal(displayCostTotals(costs).totalDollars, 2);
	});

	it("unpriced counts fold the same two stages", () => {
		assert.equal(displayCostTotals(costs).unpricedRuns, 1);
	});
});

describe("commitPayload (full positions while a group is collapsed)", () => {
	const isG = (id: string) => id.startsWith("group:");
	it("fills hidden ids from frozen, renderer wins, group ids dropped", () => {
		const frozen = new Map([["a", { x: 1, y: 1 }], ["b", { x: 2, y: 2 }], ["c", { x: 3, y: 3 }]]);
		const out = commitPayload({ a: { x: 9, y: 9 }, "group:g": { x: 5, y: 5 } }, frozen, isG);
		assert.deepEqual(out, { a: { x: 9, y: 9 }, b: { x: 2, y: 2 }, c: { x: 3, y: 3 } });
	});
	it("tolerates no frozen map", () => {
		assert.deepEqual(commitPayload({ a: { x: 1, y: 2 } }, null, isG), { a: { x: 1, y: 2 } });
	});
});
