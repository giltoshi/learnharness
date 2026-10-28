import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importableEntries, type PickedFile } from "../components/folder-import.ts";

const entry = (path: string): PickedFile => ({ file: new File(["x"], path.split("/").pop()!), path });

describe("importableEntries", () => {
	it("keeps only .md / .markdown / .txt", () => {
		const kept = importableEntries([entry("V/a.md"), entry("V/b.MARKDOWN"), entry("V/c.txt"), entry("V/d.png"), entry("V/e.pdf")]);
		assert.deepEqual(kept.map((e) => e.path), ["V/a.md", "V/b.MARKDOWN", "V/c.txt"]);
	});
	it("skips hidden files and anything under a hidden directory", () => {
		const kept = importableEntries([entry("V/.obsidian/x.md"), entry("V/.hidden.md"), entry("V/.git/y.txt"), entry("V/ok.md")]);
		assert.deepEqual(kept.map((e) => e.path), ["V/ok.md"]);
	});
});
