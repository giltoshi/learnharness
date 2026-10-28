import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyGroups } from "../src/core/groups.ts";
import { matchBareNameSources, normalizeImportPath, planFolderGroups } from "../src/core/folder-groups.ts";

let n = 0;
const mint = () => `g${++n}`;

describe("normalizeImportPath", () => {
	it("uses forward slashes and strips leading separators", () => {
		assert.equal(normalizeImportPath("FINA 411\\Risk\\Ch 05.md"), "FINA 411/Risk/Ch 05.md");
		assert.equal(normalizeImportPath("/a//b.md"), "a/b.md");
		assert.equal(normalizeImportPath("./a.md"), "a.md");
	});
});

describe("planFolderGroups", () => {
	it("mirrors the folder tree and maps each file to its folder's group", () => {
		n = 0;
		const plan = planFolderGroups(emptyGroups(), ["Vault/A/x.md", "Vault/A/y.md", "Vault/B/z.md", "Vault/top.md"], mint);
		assert.deepEqual(plan.state.groups, [
			{ id: "g1", name: "Vault" },
			{ id: "g2", name: "A", parentGroupId: "g1" },
			{ id: "g3", name: "B", parentGroupId: "g1" },
		]);
		assert.equal(plan.fileGroup.get("Vault/A/x.md"), "g2");
		assert.equal(plan.fileGroup.get("Vault/A/y.md"), "g2");
		assert.equal(plan.fileGroup.get("Vault/B/z.md"), "g3");
		assert.equal(plan.fileGroup.get("Vault/top.md"), "g1");
		assert.equal(plan.created, 3);
		assert.equal(plan.reused, 0);
	});
	it("reuses groups with the same name under the same parent", () => {
		n = 0;
		const first = planFolderGroups(emptyGroups(), ["Vault/A/x.md"], mint);
		const second = planFolderGroups(first.state, ["Vault/A/y.md", "Vault/C/z.md"], mint);
		assert.equal(second.created, 1);
		assert.equal(second.reused, 2);
		assert.equal(second.fileGroup.get("Vault/A/y.md"), "g2");
	});
	it("leaves files with no folder ungrouped", () => {
		const plan = planFolderGroups(emptyGroups(), ["solo.md"], mint);
		assert.equal(plan.fileGroup.size, 0);
		assert.deepEqual(plan.state.groups, []);
	});
	it("clamps over-long folder names to the group-name limit", () => {
		n = 0;
		const plan = planFolderGroups(emptyGroups(), [`${"x".repeat(120)}/a.md`], mint);
		assert.equal(plan.state.groups[0]!.name.length, 80);
	});
});

describe("matchBareNameSources", () => {
	const src = (id: string, filePath: string) => ({ id, filePath });
	it("matches a dropped file to the single existing bare-name source", () => {
		const m = matchBareNameSources([src("src_1", "Ch 01.md")], ["FINA/Ch 01.md", "FINA/Ch 02.md"]);
		assert.deepEqual([...m], [["FINA/Ch 01.md", "src_1"]]);
	});
	it("does not match when the bare name is ambiguous on either side", () => {
		assert.equal(matchBareNameSources([src("a", "x.md"), src("b", "x.md")], ["F/x.md"]).size, 0);
		assert.equal(matchBareNameSources([src("a", "x.md")], ["F/x.md", "G/x.md"]).size, 0);
	});
	it("never matches bare drops or exact relative re-drops", () => {
		assert.equal(matchBareNameSources([src("a", "x.md")], ["x.md"]).size, 0);
		assert.equal(matchBareNameSources([src("a", "F/x.md"), src("b", "x.md")], ["F/x.md"]).size, 0);
	});
});
