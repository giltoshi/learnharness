/**
 * Gated graph mutations for the Claude CLI tools: ONE extraction gate (409
 * semantics, same reasoning as server/graph.ts deleteGraphNode), ONE
 * snapshot per call, ONE undo point. Pure orchestration over injected deps
 * so tests need no fs; src/server/cli.ts wires the real ones.
 *
 * Group changes share the undo point but skip the gate and settle: they
 * only write groups.json, never a node or chain ledger.
 */
import { randomUUID } from "node:crypto";
import type { CliOpResult } from "../core/contracts/cli.ts";
import type { GroupsState } from "../core/contracts/graph.ts";
import type { ChatStore, GraphStore, CliStateStore } from "../core/ports.ts";
import { deleteNodeTraces } from "../core/graph-deletion.ts";
import { addSessionsOp, createGroupOp, deleteGroupOp, removeSessionsOp, renameGroupOp } from "../core/group-ops.ts";
import { GroupError } from "../core/groups.ts";
import { mergeNodes, type MergeInput, type MergeStats } from "../core/graph-merge.ts";
import { restoreLedgers, snapshotLedgers } from "../core/ledger-snapshot.ts";

export interface GraphOpsDeps {
	graphStore: GraphStore;
	/** Session ids the group ops may name (group-ops requireKnown). */
	chatStore: ChatStore;
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

	/** Snapshot → run a group op → record the undo point only if groups.json changed. */
	function withGroupUndo<T extends { message: string }>(label: (v: T, before: GroupsState) => string, run: () => T): CliOpResult<{ message: string; changed: boolean }> {
		const before = snapshotLedgers(d.graphStore);
		let value: T;
		try {
			value = run();
		} catch (err) {
			if (err instanceof GroupError) return { ok: false, code: err.code, error: err.message };
			throw err;
		}
		const changed = JSON.stringify(d.graphStore.readGroups()) !== JSON.stringify(before.groups);
		if (changed) d.state.writeUndo({ id: randomUUID(), label: label(value, before.groups!), at: now().toISOString(), revisionAfter: d.revision(), ledgers: before });
		return { ok: true, value: { message: value.message, changed } };
	}
	const deps = { chatStore: d.chatStore, graphStore: d.graphStore };
	const groupName = (state: GroupsState, id: string) => state.groups.find((g) => g.id === id)?.name ?? id;
	const sessions = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

	return {
		createGroup(input: { name: string; parentGroupId?: string; sessionIds?: string[] }) {
			return withGroupUndo((v) => `Created group "${groupName(d.graphStore.readGroups(), v.groupId)}"`, () => createGroupOp(deps, input));
		},

		addSessionsToGroup(groupId: string, sessionIds: string[]) {
			return withGroupUndo((v, before) => `Moved ${sessions(v.movedSessions)} into "${groupName(before, groupId)}"`, () => addSessionsOp(deps, groupId, sessionIds));
		},

		removeSessionsFromGroup(sessionIds: string[]) {
			return withGroupUndo((v) => `Removed ${sessions(v.removedSessions)} from ${v.removedSessions === 1 ? "its group" : "their groups"}`, () => removeSessionsOp(deps, sessionIds));
		},

		renameGroup(groupId: string, name: string) {
			return withGroupUndo((_v, before) => `Renamed group "${groupName(before, groupId)}" to "${groupName(d.graphStore.readGroups(), groupId)}"`, () => renameGroupOp(deps, groupId, name));
		},

		deleteGroup(groupId: string) {
			return withGroupUndo((_v, before) => `Deleted group "${groupName(before, groupId)}"`, () => deleteGroupOp(deps, groupId));
		},

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
