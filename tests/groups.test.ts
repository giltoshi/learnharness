import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	addSessionsToGroup,
	cleanGroupName,
	createGroup,
	deleteGroup,
	descendantGroupIds,
	emptyGroups,
	GroupError,
	groupPathLabel,
	pruneSession,
	removeSessionsFromGroup,
	renameGroup,
	sessionIdsInGroup,
	setGroupParent,
} from "../src/core/groups.ts";

const tree = () => {
	let s = emptyGroups();
	s = createGroup(s, { id: "g_fina", name: "FINA 411" });
	s = createGroup(s, { id: "g_risk", name: "Risk", parentGroupId: "g_fina" });
	s = createGroup(s, { id: "g_other", name: "Other" });
	return s;
};

describe("cleanGroupName", () => {
	it("trims and collapses whitespace", () => {
		assert.equal(cleanGroupName("  FINA   411 "), "FINA 411");
	});
	it("rejects empty and over-long names", () => {
		assert.throws(() => cleanGroupName("   "), (e) => e instanceof GroupError && e.code === "invalid_name");
		assert.throws(() => cleanGroupName("x".repeat(81)), (e) => e instanceof GroupError && e.code === "invalid_name");
	});
});

describe("createGroup / renameGroup / setGroupParent", () => {
	it("creates nested groups and rejects an unknown parent", () => {
		const s = tree();
		assert.equal(s.groups.find((g) => g.id === "g_risk")?.parentGroupId, "g_fina");
		assert.throws(
			() => createGroup(s, { id: "g_x", name: "X", parentGroupId: "nope" }),
			(e) => e instanceof GroupError && e.code === "unknown_parent",
		);
	});
	it("renames", () => {
		assert.equal(renameGroup(tree(), "g_fina", " FINA 411 F26 ").groups[0]!.name, "FINA 411 F26");
		assert.throws(() => renameGroup(tree(), "nope", "x"), (e) => e instanceof GroupError && e.code === "unknown_group");
	});
	it("re-parents and rejects cycles", () => {
		const s = tree();
		assert.equal(setGroupParent(s, "g_other", "g_fina").groups.find((g) => g.id === "g_other")?.parentGroupId, "g_fina");
		assert.equal(setGroupParent(s, "g_risk", null).groups.find((g) => g.id === "g_risk")?.parentGroupId, undefined);
		assert.throws(() => setGroupParent(s, "g_fina", "g_risk"), (e) => e instanceof GroupError && e.code === "cycle");
		assert.throws(() => setGroupParent(s, "g_fina", "g_fina"), (e) => e instanceof GroupError && e.code === "cycle");
	});
});

describe("session membership", () => {
	it("moves sessions, including ones already in another group, and reports unchanged", () => {
		let s = addSessionsToGroup(tree(), "g_risk", ["a", "b"]).state;
		const r = addSessionsToGroup(s, "g_other", ["b", "c", "c"]);
		assert.deepEqual(r.moved, ["b", "c"]);
		assert.deepEqual(r.unchanged, []);
		assert.equal(r.state.sessionGroups.b, "g_other");
		const again = addSessionsToGroup(r.state, "g_other", ["b"]);
		assert.deepEqual(again.unchanged, ["b"]);
		assert.deepEqual(again.moved, []);
	});
	it("removes sessions from their group", () => {
		const s = addSessionsToGroup(tree(), "g_risk", ["a"]).state;
		const r = removeSessionsFromGroup(s, ["a", "zzz"]);
		assert.deepEqual(r.removed, ["a"]);
		assert.deepEqual(r.unchanged, ["zzz"]);
		assert.equal(r.state.sessionGroups.a, undefined);
	});
	it("lists a group's sessions deeply by default", () => {
		let s = addSessionsToGroup(tree(), "g_risk", ["a"]).state;
		s = addSessionsToGroup(s, "g_fina", ["b"]).state;
		assert.deepEqual(sessionIdsInGroup(s, "g_fina"), ["a", "b"]);
		assert.deepEqual(sessionIdsInGroup(s, "g_fina", false), ["b"]);
		assert.deepEqual(descendantGroupIds(s, "g_fina"), ["g_risk"]);
	});
	it("prunes one session", () => {
		const s = addSessionsToGroup(tree(), "g_risk", ["a", "b"]).state;
		assert.deepEqual(pruneSession(s, "a").sessionGroups, { b: "g_risk" });
		assert.equal(pruneSession(s, "zzz"), s);
	});
});

describe("deleteGroup", () => {
	it("re-parents subgroups and held sessions to the parent", () => {
		let s = addSessionsToGroup(tree(), "g_risk", ["a"]).state;
		s = createGroup(s, { id: "g_deep", name: "Deep", parentGroupId: "g_risk" });
		const r = deleteGroup(s, "g_risk");
		assert.deepEqual(r.reparentedGroups, ["g_deep"]);
		assert.deepEqual(r.reparentedSessions, ["a"]);
		assert.equal(r.state.groups.find((g) => g.id === "g_deep")?.parentGroupId, "g_fina");
		assert.equal(r.state.sessionGroups.a, "g_fina");
		assert.equal(r.state.groups.some((g) => g.id === "g_risk"), false);
	});
	it("ungroups sessions of a top-level group and lifts its subgroups to top level", () => {
		const s = addSessionsToGroup(tree(), "g_fina", ["a"]).state;
		const r = deleteGroup(s, "g_fina");
		assert.deepEqual(r.ungroupedSessions, ["a"]);
		assert.equal(r.state.sessionGroups.a, undefined);
		assert.equal("parentGroupId" in r.state.groups.find((g) => g.id === "g_risk")!, false);
	});
});

describe("groupPathLabel", () => {
	it("joins ancestor names", () => {
		assert.equal(groupPathLabel(tree().groups, "g_risk"), "FINA 411 / Risk");
		assert.equal(groupPathLabel(tree().groups, "g_other"), "Other");
	});
});
