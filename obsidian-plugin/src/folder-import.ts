import http from "http";

/**
 * Vault-folder import: the plugin-side twin of components/folder-import.ts
 * plus postNotesImport. Obsidian-free so tests can run it under tsx.
 * Paths start with the folder's own name ("Folder/Sub/Note.md"), which the
 * server mirrors as nested groups.
 */

export interface VaultNote {
	path: string;
	content: string;
}

export interface ImportOutcome {
	completed: number;
	failed: number;
	firstError?: string;
}

const IMPORTABLE = /\.(md|markdown|txt)$/i;

/** Same rule as importableEntries: .md/.markdown/.txt, no segment starting with ".". */
export function isImportable(path: string): boolean {
	return IMPORTABLE.test(path) && !path.split("/").some((seg) => seg.startsWith("."));
}

/** `filePath` (vault-relative, under `folderPath`) re-rooted at the folder's own name. */
export function relativeImportPath(folderPath: string, folderName: string, filePath: string): string {
	return folderName + filePath.slice(folderPath.length);
}

/** The importable files under a folder, as import paths, in vault order. */
export function importPaths(folderPath: string, folderName: string, filePaths: readonly string[]): { filePath: string; path: string }[] {
	return filePaths
		.filter((filePath) => filePath.startsWith(`${folderPath}/`))
		.map((filePath) => ({ filePath, path: relativeImportPath(folderPath, folderName, filePath) }))
		.filter(({ path }) => isImportable(path));
}

/** The `files` + parallel `paths` multipart body postNotesImport sends. */
export function multipartBody(notes: readonly VaultNote[], boundary: string): Buffer {
	// Browsers' escaping for form-data names: quotes and line breaks percent-encoded.
	const quote = (s: string) => s.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
	const parts: string[] = [];
	for (const note of notes) {
		parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${quote(note.path.split("/").pop()!)}"\r\nContent-Type: text/markdown\r\n\r\n${note.content}\r\n`);
	}
	for (const note of notes) {
		parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="paths"\r\n\r\n${note.path}\r\n`);
	}
	parts.push(`--${boundary}--\r\n`);
	return Buffer.from(parts.join(""), "utf8");
}

export function summarize(body: unknown): ImportOutcome {
	const results = body && typeof body === "object" && "results" in body && Array.isArray(body.results) ? (body.results as unknown[]) : null;
	if (!results) throw new Error("Invalid import response.");
	let completed = 0;
	let failed = 0;
	let firstError: string | undefined;
	for (const raw of results) {
		const r = (raw ?? {}) as { ok?: unknown; filePath?: unknown; error?: unknown };
		if (r.ok === true) { completed++; continue; }
		failed++;
		firstError ??= `${typeof r.filePath === "string" ? r.filePath : "?"}: ${typeof r.error === "string" ? r.error : "failed"}`;
	}
	return { completed, failed, ...(firstError ? { firstError } : {}) };
}

/**
 * POST to `${url}/api/graph/import` over Node http, not fetch: the pane's
 * app://obsidian.md origin would make fetch a CORS request the server never
 * answers for. No timeout: the server awaits extraction before replying.
 */
export function postImport(url: string, notes: readonly VaultNote[]): Promise<ImportOutcome> {
	const boundary = `----learnharness${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
	const body = multipartBody(notes, boundary);
	return new Promise((resolve, reject) => {
		const req = http.request(`${url}/api/graph/import`, {
			method: "POST",
			headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("error", reject);
			res.on("end", () => {
				let parsed: unknown;
				try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
				catch { return reject(new Error(`Invalid import response (HTTP ${res.statusCode}).`)); }
				if (res.statusCode !== 200) {
					const detail = parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" ? `: ${parsed.error}` : "";
					return reject(new Error(`Import request failed (HTTP ${res.statusCode})${detail}.`));
				}
				try { resolve(summarize(parsed)); } catch (error) { reject(error); }
			});
		});
		req.on("error", reject);
		req.end(body);
	});
}
