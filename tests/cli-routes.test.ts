import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseApprovalBody, parseTurnBody } from "../src/server/cli-http.ts";

describe("cli http bodies", () => {
	it("parseTurnBody requires non-blank text and trims it", () => {
		assert.deepEqual(parseTurnBody({ text: "  hi " }), { ok: true, text: "hi" });
		assert.equal(parseTurnBody({ text: "   " }).ok, false);
		assert.equal(parseTurnBody(null).ok, false);
		assert.equal(parseTurnBody({ text: 5 }).ok, false);
	});
	it("parseApprovalBody rejects an edit with a blank name or statement", () => {
		assert.equal(parseApprovalBody({ approved: true, edit: { name: "  ", statement: "S" } }).ok, false);
		assert.equal(parseApprovalBody({ approved: true, edit: { name: "N", statement: "" } }).ok, false);
	});
	it("parseApprovalBody maps to a decision; an approval may carry an edited identity", () => {
		assert.deepEqual(parseApprovalBody({ approved: false }), { ok: true, decision: { approved: false } });
		assert.deepEqual(parseApprovalBody({ approved: true }), { ok: true, decision: { approved: true } });
		assert.deepEqual(parseApprovalBody({ approved: true, edit: { name: "N", statement: "S" } }), { ok: true, decision: { approved: true, edit: { name: "N", statement: "S" } } });
		assert.equal(parseApprovalBody({ approved: "yes" }).ok, false);
		assert.equal(parseApprovalBody({ approved: true, edit: { name: 1 } }).ok, false);
	});
});
