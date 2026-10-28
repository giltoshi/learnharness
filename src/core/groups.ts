/**
 * SESSION GROUPS — pure state operations (2026-10-27 grouping feature).
 * A group holds SESSIONS (chat ids / notes source ids), never nodes; nodes
 * inherit their group through their birth session (session-clusters.ts).
 * Groups are metadata: nothing here touches the node or chain ledgers.
 *
 * Browser-safe pure logic (no node builtins, no fs). Every operation takes
 * a GroupsState and returns a NEW one; nothing mutates its input.
 */
import type { GraphGroup, GroupsState } from "./contracts/graph.ts";

export type GroupErrorCode = "invalid_name" | "unknown_group" | "unknown_parent" | "cycle" | "unknown_session";

export class GroupError extends Error {
	constructor(
		readonly code: GroupErrorCode,
		message: string,
	) {
		super(message);
		this.name = "GroupError";
	}
}

export const GROUP_NAME_MAX = 80;

export const emptyGroups = (): GroupsState => ({ groups: [], sessionGroups: {} });

export function cleanGroupName(raw: string): string {
	const name = raw.trim().replace(/\s+/g, " ");
	if (name.length === 0) throw new GroupError("invalid_name", "A group needs a name.");
	if (name.length > GROUP_NAME_MAX) {
		throw new GroupError("invalid_name", `Group names are at most ${GROUP_NAME_MAX} characters.`);
	}
	return name;
}

const find = (state: GroupsState, id: string): GraphGroup | undefined => state.groups.find((g) => g.id === id);

function need(state: GroupsState, id: string): GraphGroup {
	const group = find(state, id);
	if (!group) throw new GroupError("unknown_group", `No group "${id}".`);
	return group;
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

const withParent = (group: GraphGroup, parentGroupId: string | undefined): GraphGroup => {
	const { parentGroupId: _old, ...rest } = group;
	return parentGroupId === undefined ? rest : { ...rest, parentGroupId };
};

/** Every group below `groupId` (not including it), breadth-first. */
export function descendantGroupIds(state: GroupsState, groupId: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>([groupId]);
	const queue = [groupId];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const g of state.groups) {
			if (g.parentGroupId === current && !seen.has(g.id)) {
				seen.add(g.id);
				out.push(g.id);
				queue.push(g.id);
			}
		}
	}
	return out;
}

export function createGroup(
	state: GroupsState,
	input: { id: string; name: string; parentGroupId?: string },
): GroupsState {
	const name = cleanGroupName(input.name);
	if (input.parentGroupId !== undefined && !find(state, input.parentGroupId)) {
		throw new GroupError("unknown_parent", `No parent group "${input.parentGroupId}".`);
	}
	const group: GraphGroup = { id: input.id, name, ...(input.parentGroupId !== undefined ? { parentGroupId: input.parentGroupId } : {}) };
	return { ...state, groups: [...state.groups, group] };
}

export function renameGroup(state: GroupsState, id: string, name: string): GroupsState {
	need(state, id);
	const clean = cleanGroupName(name);
	return { ...state, groups: state.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) };
}

/** Move a group under another group (or to top level with null). */
export function setGroupParent(state: GroupsState, id: string, parentGroupId: string | null): GroupsState {
	need(state, id);
	if (parentGroupId !== null) {
		if (!find(state, parentGroupId)) throw new GroupError("unknown_parent", `No parent group "${parentGroupId}".`);
		if (parentGroupId === id || descendantGroupIds(state, id).includes(parentGroupId)) {
			throw new GroupError("cycle", "A group cannot be moved into itself or one of its own subgroups.");
		}
	}
	return {
		...state,
		groups: state.groups.map((g) => (g.id === id ? withParent(g, parentGroupId ?? undefined) : g)),
	};
}

export function addSessionsToGroup(
	state: GroupsState,
	groupId: string,
	sessionIds: readonly string[],
): { state: GroupsState; moved: string[]; unchanged: string[] } {
	need(state, groupId);
	const sessionGroups = { ...state.sessionGroups };
	const moved: string[] = [];
	const unchanged: string[] = [];
	for (const id of unique(sessionIds)) {
		if (sessionGroups[id] === groupId) unchanged.push(id);
		else {
			sessionGroups[id] = groupId;
			moved.push(id);
		}
	}
	return { state: { ...state, sessionGroups }, moved, unchanged };
}

export function removeSessionsFromGroup(
	state: GroupsState,
	sessionIds: readonly string[],
): { state: GroupsState; removed: string[]; unchanged: string[] } {
	const sessionGroups = { ...state.sessionGroups };
	const removed: string[] = [];
	const unchanged: string[] = [];
	for (const id of unique(sessionIds)) {
		if (sessionGroups[id] === undefined) unchanged.push(id);
		else {
			delete sessionGroups[id];
			removed.push(id);
		}
	}
	return { state: { ...state, sessionGroups }, removed, unchanged };
}

/** Delete one group. Subgroups AND directly-held sessions move up to the
 *  deleted group's parent; with no parent, held sessions become ungrouped
 *  and subgroups become top-level. */
export function deleteGroup(
	state: GroupsState,
	id: string,
): { state: GroupsState; reparentedGroups: string[]; reparentedSessions: string[]; ungroupedSessions: string[] } {
	const group = need(state, id);
	const parent = group.parentGroupId;
	const reparentedGroups = state.groups.filter((g) => g.parentGroupId === id).map((g) => g.id);
	const groups = state.groups.filter((g) => g.id !== id).map((g) => (g.parentGroupId === id ? withParent(g, parent) : g));
	const sessionGroups: Record<string, string> = {};
	const reparentedSessions: string[] = [];
	const ungroupedSessions: string[] = [];
	for (const [sessionId, groupId] of Object.entries(state.sessionGroups)) {
		if (groupId !== id) {
			sessionGroups[sessionId] = groupId;
		} else if (parent !== undefined) {
			sessionGroups[sessionId] = parent;
			reparentedSessions.push(sessionId);
		} else {
			ungroupedSessions.push(sessionId);
		}
	}
	return { state: { groups, sessionGroups }, reparentedGroups, reparentedSessions, ungroupedSessions };
}

/** Drop one session's membership (the session itself was deleted). Returns
 *  the SAME state object when the session was in no group. */
export function pruneSession(state: GroupsState, sessionId: string): GroupsState {
	if (state.sessionGroups[sessionId] === undefined) return state;
	const sessionGroups = { ...state.sessionGroups };
	delete sessionGroups[sessionId];
	return { ...state, sessionGroups };
}

/** Sessions in a group, sorted. `deep` (default) includes subgroups. */
export function sessionIdsInGroup(state: GroupsState, groupId: string, deep = true): string[] {
	const wanted = new Set<string>([groupId, ...(deep ? descendantGroupIds(state, groupId) : [])]);
	return Object.entries(state.sessionGroups)
		.filter(([, g]) => wanted.has(g))
		.map(([sessionId]) => sessionId)
		.sort();
}

/** "FINA 411 / Risk" — ancestor names joined; cycle-guarded. */
export function groupPathLabel(groups: readonly GraphGroup[], id: string): string {
	const byId = new Map(groups.map((g) => [g.id, g]));
	const names: string[] = [];
	const seen = new Set<string>();
	let current = byId.get(id);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		names.unshift(current.name);
		current = current.parentGroupId === undefined ? undefined : byId.get(current.parentGroupId);
	}
	return names.join(" / ");
}
