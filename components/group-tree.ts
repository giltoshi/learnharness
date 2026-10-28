import { descendantGroupIds, groupPathLabel, type GraphGroup } from "@/src/core";

export interface SessionRow {
	id: string;
	label: string;
}
export interface GroupNode {
	group: GraphGroup;
	children: GroupNode[];
	/** Sessions held DIRECTLY by this group. */
	sessions: SessionRow[];
	/** Sessions in this group and every subgroup. */
	sessionCount: number;
}
export interface GroupTree {
	roots: GroupNode[];
	ungrouped: SessionRow[];
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

/** The Groups panel's data: nested groups, their sessions, and the sessions
 *  in no group. `sessionLabels` is every session the graph can name
 *  (chat titles + notes file paths); membership entries for sessions not in
 *  it are dead and ignored. */
export function buildGroupTree(
	groups: readonly GraphGroup[],
	sessionGroups: Readonly<Record<string, string>>,
	sessionLabels: Readonly<Record<string, string>>,
): GroupTree {
	const known = new Set(groups.map((g) => g.id));
	const held = new Map<string, SessionRow[]>();
	const ungrouped: SessionRow[] = [];
	for (const [id, label] of Object.entries(sessionLabels)) {
		const g = sessionGroups[id];
		if (g !== undefined && known.has(g)) held.set(g, [...(held.get(g) ?? []), { id, label }]);
		else ungrouped.push({ id, label });
	}
	const make = (group: GraphGroup): GroupNode => {
		const children = groups
			.filter((g) => g.parentGroupId === group.id)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(make);
		const sessions = (held.get(group.id) ?? []).sort(byLabel);
		return { group, children, sessions, sessionCount: sessions.length + children.reduce((n, c) => n + c.sessionCount, 0) };
	};
	const roots = groups
		.filter((g) => g.parentGroupId === undefined || !known.has(g.parentGroupId))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(make);
	return { roots, ungrouped: ungrouped.sort(byLabel) };
}

/** Where a group may move: every group except itself and its own subtree. */
export function moveTargets(groups: readonly GraphGroup[], groupId: string): { id: string; label: string }[] {
	const banned = new Set([groupId, ...descendantGroupIds({ groups: [...groups], sessionGroups: {} }, groupId)]);
	return groups
		.filter((g) => !banned.has(g.id))
		.map((g) => ({ id: g.id, label: groupPathLabel(groups, g.id) }))
		.sort(byLabel);
}
