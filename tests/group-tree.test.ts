import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGroupTree, moveTargets } from "../components/group-tree.ts";

const groups = [
	{ id: "g1", name: "FINA 411" },
	{ id: "g2", name: "Risk", parentGroupId: "g1" },
	{ id: "g3", name: "Another" },
];
const labels = { s1: "Ch 01.md", s2: "Ch 05.md", s3: "Loose chat", gone: "x" };

describe("buildGroupTree", () => {
	it("nests groups, attaches sessions, counts deeply and lists ungrouped sessions", () => {
		const t = buildGroupTree(groups, { s1: "g1", s2: "g2" }, { s1: "Ch 01.md", s2: "Ch 05.md", s3: "Loose chat" });
		assert.deepEqual(t.roots.map((r) => r.group.id), ["g3", "g1"]); // name-sorted: Another, FINA 411
		const fina = t.roots.find((r) => r.group.id === "g1")!;
		assert.deepEqual(fina.children.map((c) => c.group.id), ["g2"]);
		assert.deepEqual(fina.sessions.map((s) => s.id), ["s1"]);
		assert.equal(fina.sessionCount, 2);
		assert.deepEqual(t.ungrouped.map((s) => s.id), ["s3"]);
	});
	it("ignores session entries whose session is gone", () => {
		const t = buildGroupTree(groups, { ghost: "g1" }, labels);
		assert.equal(t.roots.find((r) => r.group.id === "g1")!.sessions.length, 0);
	});
});

describe("moveTargets", () => {
	it("excludes the group itself and its descendants and labels by path", () => {
		assert.deepEqual(moveTargets(groups, "g1").map((t) => t.id), ["g3"]);
		assert.deepEqual(moveTargets(groups, "g2").map((t) => t.label), ["Another", "FINA 411"]);
	});
});
