import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageMeterView } from "../components/usage-meter.tsx";
import { ApprovalCard } from "../components/cli-approval-card.tsx";
import { CliMessageView } from "../components/cli-chat.tsx";

const now = Date.parse("2026-10-27T12:00:00.000Z");
const usage = (capturedAt: string) => ({
	fiveHour: { utilization: 0.12, resetsAt: (now + 125 * 60_000) / 1000, status: "allowed" },
	sevenDay: { utilization: 0.29, resetsAt: (now + 3 * 86_400_000) / 1000, status: "allowed" },
	capturedAt,
});

describe("UsageMeterView", () => {
	it("empty state says no data yet", () => {
		assert.match(renderToStaticMarkup(<UsageMeterView usage={null} nowMs={now} />), /no data yet/i);
	});
	it("shows both percentages and reset labels, no 'as of' when fresh", () => {
		const html = renderToStaticMarkup(<UsageMeterView usage={usage(new Date(now - 60_000).toISOString())} nowMs={now} />);
		assert.match(html, /12%/); assert.match(html, /29%/);
		assert.match(html, /resets in 2h 05m/); assert.match(html, /resets in 3d 0h/);
		assert.doesNotMatch(html, /as of/i);
	});
	it("shows 'as of' when stale", () => {
		const html = renderToStaticMarkup(<UsageMeterView usage={usage(new Date(now - 30 * 60_000).toISOString())} nowMs={now} />);
		assert.match(html, /as of/i);
	});
});

describe("ApprovalCard", () => {
	const base = { id: "a", tool: "merge_nodes", title: "Merge 2 nodes into one?", lines: ["• A (n_a)", "Chains rewritten: 1 · dropped: 0"], status: "pending" as const };
	it("pending merge card shows lines, editable identity inputs, and both buttons", () => {
		const html = renderToStaticMarkup(<ApprovalCard approval={{ ...base, edit: { name: "Merged", statement: "Merged statement" } }} onDecide={() => {}} />);
		assert.match(html, /Merge 2 nodes into one\?/); assert.match(html, /Chains rewritten: 1/);
		assert.match(html, /value="Merged"/); assert.match(html, />Approve</); assert.match(html, />Reject</);
	});
	it("pending delete card has no identity inputs", () => {
		const html = renderToStaticMarkup(<ApprovalCard approval={{ ...base, tool: "delete_nodes" }} onDecide={() => {}} />);
		assert.doesNotMatch(html, /<input/);
	});
	it("settled card shows the outcome and no buttons", () => {
		const html = renderToStaticMarkup(<ApprovalCard approval={{ ...base, status: "approved" }} onDecide={() => {}} />);
		assert.match(html, /Approved/); assert.doesNotMatch(html, />Reject</);
	});
});

describe("CliMessageView", () => {
	it("renders text, a tool call, and an error part", () => {
		const html = renderToStaticMarkup(
			<CliMessageView message={{ id: "m", role: "assistant", createdAt: "t", parts: [{ type: "text", text: "Found 3 nodes" }, { type: "tool", call: { id: "t1", name: "list_nodes", input: {}, status: "done", output: "3 nodes" } }, { type: "error", message: "boom" }] }} onDecide={() => {}} />,
		);
		assert.match(html, /Found 3 nodes/); assert.match(html, /list_nodes/); assert.match(html, /boom/);
	});
});
