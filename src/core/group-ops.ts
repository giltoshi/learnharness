/**
 * SESSION-GROUP OPERATIONS over the ports (2026-10-27): the one layer both
 * the HTTP routes and the agent's group tools call. Pure state transitions
 * live in groups.ts; this adds the reads that need the graph (node counts,
 * known session ids) and the human-readable result messages. Every write
 * is ONE writeGroups at the end, so a thrown GroupError never half-applies.
 *
 * Moving sessions never touches a node or a chain, so every result carries
 * chainsAffected: 0 — the invariant the tests pin by never writing ledgers.
 */
import type { GraphStore } from "./ports.ts";
import { getGraph, type GraphDeps } from "./graph.ts";
import { birthSessionPartition } from "./session-clusters.ts";
import {
	addSessionsToGroup, cleanGroupName, createGroup, deleteGroup, GroupError,
	groupPathLabel, pruneSession, removeSessionsFromGroup, renameGroup, sessionIdsInGroup, setGroupParent,
} from "./groups.ts";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function nodeCounts(deps: GraphDeps): Map<string, number> {
	return new Map(birthSessionPartition(getGraph(deps.graphStore).nodes).map((c) => [c.id, c.members.length]));
}

const sumNodes = (counts: Map<string, number>, ids: readonly string[]): number =>
	ids.reduce((total, id) => total + (counts.get(id) ?? 0), 0);

/** Every session id the graph can name: chats, notes sources, birth sessions. */
function knownSessions(deps: GraphDeps): Set<string> {
	return new Set([
		...deps.chatStore.listChats().map((c) => c.id),
		...deps.graphStore.readSources().map((s) => s.id),
		...nodeCounts(deps).keys(),
	]);
}

function requireKnown(deps: GraphDeps, ids: readonly string[]): void {
	const known = knownSessions(deps);
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		throw new GroupError("unknown_session", `Unknown session id(s): ${unknown.join(", ")}. Call list_sessions for the current ids.`);
	}
}

const nameOf = (groups: readonly { id: string; name: string }[], id: string): string =>
	groups.find((g) => g.id === id)?.name ?? id;

export function createGroupOp(
	deps: GraphDeps,
	input: { name: string; parentGroupId?: string; sessionIds?: string[] },
) {
	const name = cleanGroupName(input.name);
	const ids = input.sessionIds ?? [];
	requireKnown(deps, ids);
	const groupId = `grp_${globalThis.crypto.randomUUID().slice(0, 8)}`;
	let state = createGroup(deps.graphStore.readGroups(), { id: groupId, name, parentGroupId: input.parentGroupId });
	let moved: string[] = [];
	if (ids.length > 0) {
		const r = addSessionsToGroup(state, groupId, ids);
		state = r.state;
		moved = r.moved;
	}
	deps.graphStore.writeGroups(state);
	const nodes = sumNodes(nodeCounts(deps), moved);
	return {
		groupId,
		movedSessions: moved.length,
		nodes,
		chainsAffected: 0 as const,
		message: `Created group '${name}' (${groupId}). Moved ${plural(moved.length, "session")} (${plural(nodes, "node")}) into it. 0 chains affected.`,
	};
}

export function addSessionsOp(deps: GraphDeps, groupId: string, sessionIds: string[]) {
	requireKnown(deps, sessionIds);
	const before = deps.graphStore.readGroups();
	const r = addSessionsToGroup(before, groupId, sessionIds);
	deps.graphStore.writeGroups(r.state);
	const nodes = sumNodes(nodeCounts(deps), r.moved);
	const already = r.unchanged.length > 0 ? `; ${r.unchanged.length} already there` : "";
	return {
		movedSessions: r.moved.length,
		unchangedSessions: r.unchanged.length,
		nodes,
		chainsAffected: 0 as const,
		message: `Moved ${plural(r.moved.length, "session")} (${plural(nodes, "node")}) into '${nameOf(before.groups, groupId)}'${already}. 0 chains affected.`,
	};
}

export function removeSessionsOp(deps: GraphDeps, sessionIds: string[]) {
	const r = removeSessionsFromGroup(deps.graphStore.readGroups(), sessionIds);
	deps.graphStore.writeGroups(r.state);
	const nodes = sumNodes(nodeCounts(deps), r.removed);
	const notGrouped = r.unchanged.length > 0 ? ` ${r.unchanged.length} was not in a group.` : "";
	return {
		removedSessions: r.removed.length,
		nodes,
		chainsAffected: 0 as const,
		message: `Removed ${plural(r.removed.length, "session")} (${plural(nodes, "node")}) from their groups. 0 chains affected.${notGrouped}`,
	};
}

export function renameGroupOp(deps: GraphDeps, groupId: string, name: string) {
	const before = deps.graphStore.readGroups();
	const clean = cleanGroupName(name);
	const old = nameOf(before.groups, groupId);
	deps.graphStore.writeGroups(renameGroup(before, groupId, clean));
	return { message: `Renamed group '${old}' to '${clean}'.` };
}

export function setGroupParentOp(deps: GraphDeps, groupId: string, parentGroupId: string | null) {
	const before = deps.graphStore.readGroups();
	const next = setGroupParent(before, groupId, parentGroupId);
	deps.graphStore.writeGroups(next);
	const name = nameOf(before.groups, groupId);
	return {
		message:
			parentGroupId === null
				? `Moved group '${name}' to the top level.`
				: `Moved group '${name}' into '${nameOf(before.groups, parentGroupId)}'.`,
	};
}

export function previewDeleteGroupOp(deps: GraphDeps, groupId: string) {
	const before = deps.graphStore.readGroups();
	const r = deleteGroup(before, groupId); // dry run: nothing is written
	const name = nameOf(before.groups, groupId);
	const held =
		r.reparentedSessions.length > 0
			? `move ${plural(r.reparentedSessions.length, "session")} up`
			: `leave ${plural(r.ungroupedSessions.length, "session")} ungrouped`;
	return { message: `Deleting group '${name}' would ${held} and move ${plural(r.reparentedGroups.length, "subgroup")}.` };
}

export function deleteGroupOp(deps: GraphDeps, groupId: string) {
	const before = deps.graphStore.readGroups();
	const r = deleteGroup(before, groupId);
	deps.graphStore.writeGroups(r.state);
	const name = nameOf(before.groups, groupId);
	const held =
		r.reparentedSessions.length > 0
			? `${plural(r.reparentedSessions.length, "session")} moved up`
			: `${plural(r.ungroupedSessions.length, "session")} left ungrouped`;
	return {
		reparentedGroups: r.reparentedGroups.length,
		reparentedSessions: r.reparentedSessions.length,
		ungroupedSessions: r.ungroupedSessions.length,
		chainsAffected: 0 as const,
		message: `Deleted group '${name}'. ${held}, ${plural(r.reparentedGroups.length, "subgroup")} moved up. 0 chains affected.`,
	};
}

export function listGroupsOp(deps: GraphDeps) {
	const state = deps.graphStore.readGroups();
	const counts = nodeCounts(deps);
	return state.groups
		.map((g) => {
			const sessions = sessionIdsInGroup(state, g.id);
			return {
				id: g.id,
				name: g.name,
				path: groupPathLabel(state.groups, g.id),
				parentGroupId: g.parentGroupId ?? null,
				sessions: sessions.length,
				nodes: sumNodes(counts, sessions),
			};
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** A deleted session leaves its group. Writes only when it was grouped. */
export function pruneSessionOp(graphStore: Pick<GraphStore, "readGroups" | "writeGroups">, sessionId: string): void {
	const before = graphStore.readGroups();
	const after = pruneSession(before, sessionId);
	if (after !== before) graphStore.writeGroups(after);
}
