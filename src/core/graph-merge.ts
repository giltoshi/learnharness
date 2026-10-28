/**
 * Node merge — the third ledger writer (after extraction and deletion),
 * held to the same discipline as core/graph-deletion.ts: pure code over the
 * GraphStore port, no LLM judgment, deterministic, ONE synchronous block
 * (no awaits) so nothing interleaves between read and rewrite. The caller
 * owns the gates (extraction running → refuse) and the layout settle.
 *
 * The merged node's identity (name/statement) is SUPPLIED by the caller —
 * the old names, statements and aliases all survive as aliases, and the
 * provenance unions, so no phrasing or session link is lost.
 */
import { randomBytes } from "node:crypto";
import type { CliOpResult } from "./contracts/cli.ts";
import type { GraphChain, GraphNode, ProvenancePoint } from "./contracts.ts";
import type { GraphStore } from "./ports.ts";

export interface MergeInput {
	ids: string[];
	name: string;
	statement: string;
}

export interface MergePreview {
	found: Array<{ id: string; name: string }>;
	missing: string[];
	/** Distinct chains (arg_ ids) that survive re-pointed at the merged node. */
	chainsRewritten: number;
	/** Distinct chains that die (they would become self-referential). */
	chainsDropped: number;
}

export interface MergeStats {
	nodesMerged: number;
	chainsRewritten: number;
	chainsDropped: number;
}

type Reader = Pick<GraphStore, "readNodes" | "readChains">;

const chainKey = (premises: ReadonlyArray<string>, conclusion: string): string =>
	`${[...premises].sort().join("+")}>${conclusion}`;

interface Remap {
	lines: GraphChain[];
	rewritten: Set<string>;
	dropped: Set<string>;
}

/** Re-point every chain line at `newId`; drop self-referential lines; make
 *  lines that now share a key share one chain id (first wins). */
function remapChains(chains: GraphChain[], merged: ReadonlySet<string>, newId: string): Remap {
	const touches = (c: GraphChain) => merged.has(c.conclusion) || c.premises.some((p) => merged.has(p));
	const out: GraphChain[] = [];
	const rewritten = new Set<string>();
	const dropped = new Set<string>();
	const idOfKey = new Map<string, string>();
	// Keys of untouched lines claim their ids first so a remapped line joining
	// an existing argument reuses that argument's id.
	for (const c of chains) if (!touches(c) && !idOfKey.has(chainKey(c.premises, c.conclusion))) idOfKey.set(chainKey(c.premises, c.conclusion), c.id);
	for (const c of chains) {
		if (!touches(c)) { out.push(c); continue; }
		const conclusion = merged.has(c.conclusion) ? newId : c.conclusion;
		const premises = [...new Set(c.premises.map((p) => (merged.has(p) ? newId : p)))].filter((p) => p !== conclusion);
		if (premises.length === 0) { dropped.add(c.id); continue; }
		const key = chainKey(premises, conclusion);
		const id = idOfKey.get(key) ?? c.id;
		idOfKey.set(key, id);
		rewritten.add(c.id);
		out.push({ ...c, id, premises, conclusion });
	}
	// An id counts as dropped only if NONE of its lines survived.
	for (const id of [...dropped]) if (rewritten.has(id)) dropped.delete(id);
	return { lines: out, rewritten, dropped };
}

export function previewMerge(store: Reader, ids: string[]): MergePreview {
	const wanted = [...new Set(ids)];
	const byId = new Map<string, GraphNode>();
	for (const n of store.readNodes()) if (!byId.has(n.id)) byId.set(n.id, n);
	const found = wanted.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)!.name }));
	const missing = wanted.filter((id) => !byId.has(id));
	const { rewritten, dropped } = remapChains(store.readChains(), new Set(found.map((f) => f.id)), "__preview__");
	return { found, missing, chainsRewritten: rewritten.size, chainsDropped: dropped.size };
}

export function mergeNodes(
	store: GraphStore,
	input: MergeInput,
	opts: { newId?: string; now?: string } = {},
): CliOpResult<{ newId: string } & MergeStats> {
	const name = input.name.trim();
	const statement = input.statement.trim();
	if (name === "" || statement === "") return { ok: false, code: "bad_identity", error: "A merged node needs a non-empty name and statement" };
	const ids = [...new Set(input.ids)];
	if (ids.length < 2) return { ok: false, code: "too_few", error: "Merging needs at least two distinct node ids" };

	const nodeLines = store.readNodes();
	const known = new Set(nodeLines.map((n) => n.id));
	const missing = ids.filter((id) => !known.has(id));
	if (missing.length > 0) return { ok: false, code: "not_found", error: `Unknown node ids: ${missing.join(", ")}` };

	const mergedIds = new Set(ids);
	const newId = opts.newId ?? `n_${randomBytes(6).toString("hex")}`;
	const sources = nodeLines.filter((n) => mergedIds.has(n.id));

	const aliases: string[] = [];
	const seenAlias = new Set([name, statement]);
	for (const line of sources) {
		for (const phrasing of [line.name, line.statement, ...line.aliases]) {
			if (phrasing.length > 0 && !seenAlias.has(phrasing)) { seenAlias.add(phrasing); aliases.push(phrasing); }
		}
	}
	const provenance: ProvenancePoint[] = [];
	const seenPoint = new Set<string>();
	for (const line of sources) {
		for (const pt of line.provenance) {
			const k = `${pt.chatId}\u0000${pt.messageId}`;
			if (!seenPoint.has(k)) { seenPoint.add(k); provenance.push(pt); }
		}
	}
	const createdAt = sources.map((n) => n.createdAt).sort()[0]!;
	const mergedNode: GraphNode = { id: newId, name, statement, aliases, createdAt, provenance };

	const chainLines = store.readChains();
	const remap = remapChains(chainLines, mergedIds, newId);
	// A chain id is dead when none of its lines survive (dropped, or all its
	// lines were re-homed under an earlier colliding id).
	const surviving = new Set(remap.lines.map((c) => c.id));
	const dead = new Set(chainLines.map((c) => c.id).filter((id) => !surviving.has(id)));

	store.rewriteLedgers({
		nodes: [...nodeLines.filter((n) => !mergedIds.has(n.id)), mergedNode],
		chains: remap.lines,
	});

	const positions = store.readPositions();
	const kept = Object.fromEntries(Object.entries(positions).filter(([id]) => !mergedIds.has(id) && !dead.has(id)));
	if (Object.keys(kept).length !== Object.keys(positions).length) store.writePositions(kept);

	return {
		ok: true,
		value: {
			newId,
			nodesMerged: ids.length,
			chainsRewritten: remap.rewritten.size,
			chainsDropped: remap.dropped.size,
		},
	};
}
