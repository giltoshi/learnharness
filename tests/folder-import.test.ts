import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entriesFromDrop, importableEntries, type PickedFile } from "../components/folder-import.ts";

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

// Fake FileSystemEntry trees (the real ones are browser-only).
const fileEntry = (name: string) => ({
	name,
	isFile: true,
	isDirectory: false,
	file: (ok: (f: File) => void) => ok(new File(["x"], name)),
});
const dirEntry = (name: string, batches: unknown[][], onRead?: () => void) => ({
	name,
	isFile: false,
	isDirectory: true,
	createReader: () => {
		onRead?.();
		const queue = [...batches, []];
		return { readEntries: (ok: (b: unknown[]) => void) => ok(queue.shift()!) };
	},
});
const dropOf = (...roots: unknown[]) =>
	({ items: roots.map((r) => ({ webkitGetAsEntry: () => r })) }) as unknown as DataTransfer;

describe("entriesFromDrop", () => {
	it("never reads a hidden directory", async () => {
		let read = false;
		const hidden = dirEntry(".obsidian", [[fileEntry("x.md")]], () => (read = true));
		const root = dirEntry("Vault", [[hidden, fileEntry("ok.md")]]);
		const out = await entriesFromDrop(dropOf(root));
		assert.equal(read, false);
		assert.deepEqual(out.map((e) => e.path), ["Vault/ok.md"]);
	});
	it("loops readEntries batches until empty, with relative paths", async () => {
		const sub = dirEntry("Sub", [[fileEntry("a.md")], [fileEntry("b.md")]]);
		const out = await entriesFromDrop(dropOf(dirEntry("Vault", [[sub]])));
		assert.deepEqual(out.map((e) => e.path), ["Vault/Sub/a.md", "Vault/Sub/b.md"]);
	});
	it("applies the importable filter", async () => {
		const out = await entriesFromDrop(dropOf(dirEntry("V", [[fileEntry("a.md"), fileEntry("b.png")]])));
		assert.deepEqual(out.map((e) => e.path), ["V/a.md"]);
	});
});
