import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// The data-dir seam BEFORE any config-loading import (schema-stamps discipline).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-groups-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { graphStore } = await import("../src/store/graph.ts");
const { GROUPS_FILE, GRAPH_FORMAT_FILE } = await import("../config.ts");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

test("no groups file reads as empty and does not stamp the family", () => {
	assert.deepEqual(graphStore.readGroups(), { groups: [], sessionGroups: {} });
	assert.ok(!fs.existsSync(GROUPS_FILE));
	assert.ok(!fs.existsSync(GRAPH_FORMAT_FILE));
});

test("writeGroups round-trips and stamps the family at the current version", () => {
	graphStore.writeGroups({
		groups: [{ id: "g1", name: "FINA 411" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
		sessionGroups: { src_a: "g2" },
	});
	assert.deepEqual(graphStore.readGroups(), {
		groups: [{ id: "g1", name: "FINA 411" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
		sessionGroups: { src_a: "g2" },
	});
	assert.equal(JSON.parse(fs.readFileSync(GRAPH_FORMAT_FILE, "utf8")).version, 2);
});

test("reads drop malformed groups and session entries pointing at unknown groups", () => {
	fs.writeFileSync(
		GROUPS_FILE,
		JSON.stringify({ groups: [{ id: "g1", name: "ok" }, { id: 5 }, "junk"], sessionGroups: { a: "g1", b: "ghost", c: 7 } }),
		"utf-8",
	);
	assert.deepEqual(graphStore.readGroups(), { groups: [{ id: "g1", name: "ok" }], sessionGroups: { a: "g1" } });
});

test("a corrupt file reads as empty, never throws", () => {
	fs.writeFileSync(GROUPS_FILE, "{not json", "utf-8");
	assert.deepEqual(graphStore.readGroups(), { groups: [], sessionGroups: {} });
});

test("a NEWER-stamped family refuses reads honestly", () => {
	fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: 99 }), "utf-8");
	assert.throws(() => graphStore.readGroups(), /format version 99/);
});
