/**
 * Gated graph mutations for the Claude CLI tools: ONE extraction gate (409
 * semantics, same reasoning as server/graph.ts deleteGraphNode), ONE
 * snapshot per call, ONE undo point. Pure orchestration over injected deps
 * so tests need no fs; src/server/cli.ts wires the real ones.
 */
import { randomUUID } from "node:crypto";
import type { CliOpResult } from "../core/contracts/cli.ts";
import type { GraphStore, CliStateStore } from "../core/ports.ts";
import { deleteNodeTraces } from "../core/graph-deletion.ts";
import { mergeNodes, type MergeInput, type MergeStats } from "../core/graph-merge.ts";
import { restoreLedgers, snapshotLedgers } from "../core/ledger-snapshot.ts";

export interface GraphOpsDeps {
	graphStore: GraphStore;
	state: Pick<CliStateStore, "readUndo" | "writeUndo" | "clearUndo">;
	extractionBusy(): boolean;
	/** graphRevision(): moves on any graph write. */
	revision(): number;
	/** settleGraphLayout(graphStore) — absorbs new nodes into the layout. */
	settle(): void;
	now?(): Date;
}

const BUSY = { ok: false as const, code: "extraction_running", error: "An extraction is running — try again when it finishes" };

export function createGraphOps(d: GraphOpsDeps) {
	const now = () => (d.now ?? (() => new Date()))();

	/** Snapshot → run → (if it changed anything) settle + record the undo point. */
	function withUndo<T>(label: (v: T) => string, run: () => CliOpResult<T>, changed: (v: T) => boolean): CliOpResult<T> {
		if (d.extractionBusy()) return BUSY;
		const before = snapshotLedgers(d.graphStore);
		const result = run();
		if (!result.ok || !changed(result.value)) return result;
		d.settle();
		d.state.writeUndo({ id: randomUUID(), label: label(result.value), at: now().toISOString(), revisionAfter: d.revision(), ledgers: before });
		return result;
	}

	return {
		mergeNodes(input: MergeInput): CliOpResult<{ newId: string } & MergeStats> {
			const label = `Merged ${new Set(input.ids).size} nodes into "${input.name.trim()}"`;
			return withUndo(() => label, () => mergeNodes(d.graphStore, input), () => true);
		},

		deleteNodes(ids: string[]): CliOpResult<{ deleted: string[]; missing: string[]; chainsRemoved: number }> {
			const unique = [...new Set(ids)];
			return withUndo(
				(v) => `Deleted ${v.deleted.length} node${v.deleted.length === 1 ? "" : "s"}`,
				() => {
					const deleted: string[] = [];
					const missing: string[] = [];
					let chainsRemoved = 0;
					for (const id of unique) {
						const stats = deleteNodeTraces(d.graphStore, id);
						if (stats === null) missing.push(id);
						else { deleted.push(id); chainsRemoved += stats.chainsRemoved; }
					}
					return { ok: true, value: { deleted, missing, chainsRemoved } };
				},
				(v) => v.deleted.length > 0,
			);
		},

		undoInfo(): { label: string; at: string } | null {
			const rec = d.state.readUndo();
			return rec && rec.revisionAfter === d.revision() ? { label: rec.label, at: rec.at } : null;
		},

		undo(): CliOpResult<{ label: string }> {
			if (d.extractionBusy()) return BUSY;
			const rec = d.state.readUndo();
			if (rec === null) return { ok: false, code: "nothing_to_undo", error: "There is nothing to undo" };
			if (rec.revisionAfter !== d.revision()) {
				return { ok: false, code: "stale", error: "The graph changed since that action, so it can no longer be undone safely" };
			}
			restoreLedgers(d.graphStore, rec.ledgers);
			d.state.clearUndo();
			return { ok: true, value: { label: rec.label } };
		},
	};
}
