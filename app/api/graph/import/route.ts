/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", any text format — the extractor is format-agnostic); the
 * pipeline mints a deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 */
import { extraction, NotesImportError, notesSourceId, stores } from "@/src/server";
import {
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
	applyFolderGroups,
	matchBareNameSources,
	normalizeImportPath,
	type EmissionStats,
} from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The machine discriminator when ok:false is a config refusal — the
	 * BYOK models refusal (owner, 2026-09-22) or the provider-key refusal
	 * (2026-09-25); the client can open the setup/keys flow off it. */
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
	/** Folder import: the earlier bare-name source this file was matched to
	 * (placed in its group, not re-extracted). */
	reusedSourceId?: string;
}

export async function POST(request: Request) {
	const form = await request.formData();
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	// Folder import: a parallel "paths" field carries each file's relative
	// path (browsers do not reliably preserve slashes in multipart file
	// names). No field = today's bare file names, byte-for-byte.
	const rawPaths = form.getAll("paths").map(String);
	if (rawPaths.length !== 0 && rawPaths.length !== files.length) {
		return Response.json({ results: [] as ImportResult[], error: "paths must match files" }, { status: 400 });
	}
	const paths = files.map((file, i) => (rawPaths.length === 0 ? file.name : normalizeImportPath(rawPaths[i]!)));
	if (paths.some((p) => p === "")) {
		return Response.json({ results: [] as ImportResult[], error: "empty path" }, { status: 400 });
	}

	const results: ImportResult[] = [];
	let reuse = new Map<string, string>();
	if (rawPaths.length > 0 && paths.some((p) => p.includes("/"))) {
		reuse = matchBareNameSources(stores.graphStore.readSources(), paths);
		applyFolderGroups(stores.graphStore, paths, notesSourceId, reuse);
		// Already-imported (bare-name) files: placed in their group above,
		// not re-extracted.
		for (const [path, sourceId] of reuse) {
			const requestIndex = paths.indexOf(path);
			results.push({ requestIndex, filePath: path, outcome: "completed", ok: true, stats: { nodes: 0, chains: 0 }, reusedSourceId: sourceId });
		}
	}
	const queue = files
		.map((file, requestIndex) => ({ file, requestIndex, filePath: paths[requestIndex]! }))
		.filter((entry) => !reuse.has(entry.filePath));
	const workers = Array.from({ length: Math.min(3, Math.max(queue.length, 1)) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex, filePath } = next;
			try {
				const text = await file.text();
				const stats = await extraction.importNotes({ filePath, text });
				results.push({ filePath, requestIndex, outcome: "completed", ok: true, stats });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({
						filePath,
						ok: false,
						requestIndex, outcome: "failed",
						error: err.envelope.error,
						code: "models_not_configured",
						missing: err.envelope.missing,
					});
					continue;
				}
				if (err instanceof ProviderKeyMissingError) {
					results.push({
						filePath,
						ok: false,
						requestIndex, outcome: "failed",
						error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE,
						provider: err.envelope.provider,
						slots: err.envelope.slots,
					});
					continue;
				}
				results.push({
					filePath, requestIndex, ok: false,
					outcome: err instanceof NotesImportError ? err.outcome : "failed",
					...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}