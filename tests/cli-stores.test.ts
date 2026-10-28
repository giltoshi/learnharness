import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createCliChatStore } from "../src/store/cli-chats.ts";
import { createCliStateStore } from "../src/store/cli-state.ts";
import { newCliMessage } from "../src/core/cli-chat.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-store-"));

describe("cli chat store", () => {
	it("create → get → list → save → rename → delete", () => {
		const store = createCliChatStore(tmp());
		const chat = store.create();
		assert.equal(chat.title, "New CLI chat");
		assert.deepEqual(store.get(chat.id)?.messages, []);
		const msgs = [newCliMessage("user", "m1", "2026-10-27T00:00:00.000Z", "hi")];
		const saved = store.save(chat.id, { messages: msgs, cliSessionId: "sess-1" });
		assert.equal(saved.cliSessionId, "sess-1");
		assert.equal(store.list()[0]!.messageCount, 1);
		assert.equal(store.rename(chat.id, "  FINA 411 cleanup ").title, "FINA 411 cleanup");
		assert.equal(store.delete(chat.id), true);
		assert.equal(store.get(chat.id), null);
		assert.equal(store.delete(chat.id), false);
	});
	it("list is newest-activity first; rename does not reorder", () => {
		const store = createCliChatStore(tmp());
		const a = store.create("A");
		const b = store.create("B");
		store.save(a.id, { messages: [newCliMessage("user", "m", "2026-10-27T00:00:00.000Z", "x")] });
		assert.deepEqual(store.list().map((c) => c.title), ["A", "B"]);
		const before = store.list().map((c) => c.updatedAt);
		store.rename(b.id, "B2");
		assert.deepEqual(store.list().map((c) => c.updatedAt), before);
	});
	it("rejects path-like ids and returns null for unknown / corrupt files", () => {
		const dir = tmp();
		const store = createCliChatStore(dir);
		assert.throws(() => store.get("../x"));
		fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
		assert.equal(store.get("bad"), null);
		assert.equal(store.get("missing"), null);
	});
	it("rename of an unknown chat throws", () => {
		assert.throws(() => createCliChatStore(tmp()).rename("nope", "x"));
	});
});

describe("cli state store", () => {
	it("usage and undo round-trip; clearUndo removes", () => {
		const store = createCliStateStore(tmp());
		assert.equal(store.readUsage(), null);
		const usage = { fiveHour: { utilization: 0.1, resetsAt: 1, status: "allowed" }, sevenDay: null, capturedAt: "t" };
		store.writeUsage(usage);
		assert.deepEqual(store.readUsage(), usage);
		assert.equal(store.readUndo(), null);
		const undo = { id: "u", label: "l", at: "t", revisionAfter: 5, ledgers: { nodes: [], chains: [], coverage: [], checkpoints: [], positions: {} } };
		store.writeUndo(undo);
		assert.deepEqual(store.readUndo(), undo);
		store.clearUndo();
		assert.equal(store.readUndo(), null);
	});
	it("a corrupt file reads as null", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "usage.json"), "{x");
		assert.equal(createCliStateStore(dir).readUsage(), null);
	});
});
