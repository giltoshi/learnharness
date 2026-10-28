import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { importPaths, multipartBody, postImport, summarize } from "../obsidian-plugin/src/folder-import.ts";

describe("importPaths", () => {
	it("roots paths at the folder's own name and keeps only importable files under it", () => {
		const got = importPaths("Notes/Vault", "Vault", [
			"Notes/Vault/a.md", "Notes/Vault/Sub/b.MARKDOWN", "Notes/Vault/c.txt", "Notes/Vault/d.png",
			"Notes/Vault/.hidden/e.md", "Notes/Vault/.f.md", "Notes/VaultOther/g.md", "Other/h.md",
		]);
		assert.deepEqual(got, [
			{ filePath: "Notes/Vault/a.md", path: "Vault/a.md" },
			{ filePath: "Notes/Vault/Sub/b.MARKDOWN", path: "Vault/Sub/b.MARKDOWN" },
			{ filePath: "Notes/Vault/c.txt", path: "Vault/c.txt" },
		]);
	});
	it("works for a top-level folder", () => {
		assert.deepEqual(importPaths("Vault", "Vault", ["Vault/x/y.md"]), [{ filePath: "Vault/x/y.md", path: "Vault/x/y.md" }]);
	});
});

describe("multipartBody", () => {
	it("encodes parallel files and paths fields a standard parser reads back", async () => {
		const notes = [{ path: "V/Sub/Ünï \"q\".md", content: "# hi\nthere" }, { path: "V/b.txt", content: "" }];
		const form = await new Request("http://x", {
			method: "POST",
			headers: { "Content-Type": "multipart/form-data; boundary=BND" },
			body: new Uint8Array(multipartBody(notes, "BND")),
		}).formData();
		const files = form.getAll("files") as File[];
		assert.deepEqual(form.getAll("paths"), notes.map((n) => n.path));
		assert.deepEqual(await Promise.all(files.map((f) => f.text())), ["# hi\nthere", ""]);
		assert.equal(files[1]!.name, "b.txt");
	});
});

describe("summarize", () => {
	it("counts completed vs everything else and keeps the first error", () => {
		assert.deepEqual(summarize({ results: [
			{ ok: true, filePath: "V/a.md" },
			{ ok: false, filePath: "V/b.md", error: "boom" },
			{ ok: false, filePath: "V/c.md", error: "later" },
		] }), { completed: 1, failed: 2, firstError: "V/b.md: boom" });
		assert.deepEqual(summarize({ results: [{ ok: true }] }), { completed: 1, failed: 0 });
		assert.throws(() => summarize({}));
	});
});

describe("postImport", () => {
	const serve = (handler: http.RequestListener) => new Promise<{ url: string; close: () => void }>((resolve) => {
		const srv = http.createServer(handler).listen(0, "127.0.0.1", () => {
			resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() });
		});
	});

	it("posts to /api/graph/import and summarizes the reply", async () => {
		let seen: { url?: string; paths?: unknown[] } = {};
		const { url, close } = await serve(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const form = await new Request("http://x", { method: "POST", headers: { "Content-Type": req.headers["content-type"]! }, body: Buffer.concat(chunks) }).formData();
			seen = { url: req.url, paths: form.getAll("paths") };
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ results: [{ ok: true, filePath: "V/a.md" }] }));
		});
		try {
			assert.deepEqual(await postImport(url, [{ path: "V/a.md", content: "a" }]), { completed: 1, failed: 0 });
			assert.deepEqual(seen, { url: "/api/graph/import", paths: ["V/a.md"] });
		} finally { close(); }
	});

	it("rejects with the server's error on a non-200", async () => {
		const { url, close } = await serve((_req, res) => { res.statusCode = 400; res.end(JSON.stringify({ results: [], error: "no files" })); });
		try { await assert.rejects(postImport(url, [{ path: "V/a.md", content: "a" }]), /HTTP 400\): no files/); }
		finally { close(); }
	});
});
