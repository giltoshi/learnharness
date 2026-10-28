/**
 * GROUP COLLAPSE PROJECTION (2026-10-27): the pure transform between the
 * snapshot and the canvas. A COLLAPSED group becomes ONE blob node
 * ("group:<id>", at the centroid of its members); every edge touching a
 * member is re-pointed at the blob, internal edges vanish, and parallel
 * edges bundle into one. EXPANDED groups contribute a labeled box. Nothing
 * is stored or mutated: the same snapshot + a different `collapsed` set
 * is a different picture, so collapse can never lose or alter a chain.
 *
 * A node belongs to its birth session's group (propositions) or, for a
 * derived implication node, the session impClusterKey picks (premise
 * majority) — the same rule the cluster regions use.
 */
import { birthSessionOf, impClusterKey, type GraphGroup, type GraphNode } from "@/src/core";

export const GROUP_NODE_PREFIX = "group:";
export const isGroupNodeId = (id: string): boolean => id.startsWith(GROUP_NODE_PREFIX);

type Edge = { from: string; to: string };
type Cluster = { id: string; label: string | null; members: string[] };

export interface ProjectionInput {
	nodes: ReadonlyArray<{ id: string; name: string }>;
	propositions: ReadonlyArray<Pick<GraphNode, "id" | "provenance">>;
	edges: ReadonlyArray<Edge>;
	logicalEdges: ReadonlyArray<Edge>;
	impLinks: ReadonlyArray<{ id: string; premises: string[]; conclusion: string }>;
	clusters: ReadonlyArray<Cluster>;
	groups: ReadonlyArray<GraphGroup>;
	sessionGroups: Readonly<Record<string, string>>;
	collapsed: ReadonlySet<string>;
}

export interface ProjectedGroupBox {
	id: string;
	label: string;
	/** 0 for a leaf box; grows with nesting depth BELOW it (outer boxes pad wider). */
	level: number;
	members: string[];
}

export interface Projection {
	nodes: { id: string; x: number; y: number; label: string }[];
	edges: Edge[];
	logicalEdges: Edge[];
	impLinks: { id: string; premises: string[]; conclusion: string }[];
	clusters: Cluster[];
	groupBoxes: ProjectedGroupBox[];
	blobIds: string[];
}

export function projectGroups(input: ProjectionInput, pos: (id: string) => { x: number; y: number }): Projection {
	const byId = new Map(input.groups.map((g) => [g.id, g]));

	/** [self, parent, …, root], cycle-guarded. */
	const ancestry = (groupId: string): string[] => {
		const out: string[] = [];
		const seen = new Set<string>();
		let cur: string | undefined = groupId;
		while (cur !== undefined && !seen.has(cur) && byId.has(cur)) {
			seen.add(cur);
			out.push(cur);
			cur = byId.get(cur)!.parentGroupId;
		}
		return out;
	};

	// node id → its session (propositions: birth; imp nodes: premise majority).
	const sessionOf = new Map<string, string | null>();
	for (const p of input.propositions) sessionOf.set(p.id, birthSessionOf(p));
	for (const link of input.impLinks) {
		sessionOf.set(link.id, impClusterKey({ premises: link.premises, provenance: [] }, (id) => sessionOf.get(id) ?? null));
	}
	const propositionIds = new Set(input.propositions.map((p) => p.id));

	const groupOfNode = (id: string): string | undefined => {
		const session = sessionOf.get(id);
		return session == null ? undefined : input.sessionGroups[session];
	};
	/** The OUTERMOST collapsed group containing this node, or null. */
	const blobOf = (id: string): string | null => {
		const g = groupOfNode(id);
		if (g === undefined) return null;
		let blob: string | null = null;
		for (const a of ancestry(g)) if (input.collapsed.has(a)) blob = a;
		return blob;
	};
	const rep = (id: string): string => {
		const b = blobOf(id);
		return b === null ? id : GROUP_NODE_PREFIX + b;
	};

	// Nodes: visible ones pass through, members fold into their blob.
	const nodes: Projection["nodes"] = [];
	const blobMembers = new Map<string, string[]>();
	for (const n of input.nodes) {
		const b = blobOf(n.id);
		if (b === null) nodes.push({ id: n.id, ...pos(n.id), label: n.name });
		else blobMembers.set(b, [...(blobMembers.get(b) ?? []), n.id]);
	}
	const blobIds: string[] = [];
	for (const [groupId, members] of blobMembers) {
		const blobId = GROUP_NODE_PREFIX + groupId;
		// Centroid of the PROPOSITION members: imp nodes are invisible geometry.
		const placed = members.filter((m) => propositionIds.has(m));
		const ps = (placed.length > 0 ? placed : members).map(pos);
		const x = ps.reduce((s, p) => s + p.x, 0) / ps.length;
		const y = ps.reduce((s, p) => s + p.y, 0) / ps.length;
		const count = members.filter((m) => propositionIds.has(m)).length;
		nodes.push({ id: blobId, x, y, label: `${byId.get(groupId)?.name ?? groupId} · ${count}` });
		blobIds.push(blobId);
	}

	const bundle = (list: ReadonlyArray<Edge>): Edge[] => {
		const seen = new Set<string>();
		const out: Edge[] = [];
		for (const e of list) {
			const from = rep(e.from);
			const to = rep(e.to);
			if (from === to) continue;
			const key = `${from}\u0000${to}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ from, to });
		}
		return out;
	};

	const impLinks: Projection["impLinks"] = [];
	for (const link of input.impLinks) {
		if (rep(link.id) !== link.id) continue; // the imp node folded into a blob
		const conclusion = rep(link.conclusion);
		const premises = [...new Set(link.premises.map(rep))].filter((p) => p !== conclusion);
		if (premises.length > 0) impLinks.push({ id: link.id, premises, conclusion });
	}

	const clusters: Cluster[] = input.clusters
		.map((c) => ({ id: c.id, label: c.label, members: c.members.filter((m) => rep(m) === m) }))
		.filter((c) => c.members.length > 0);
	for (const blobId of blobIds) {
		clusters.push({ id: blobId, label: byId.get(blobId.slice(GROUP_NODE_PREFIX.length))?.name ?? null, members: [blobId] });
	}

	// Boxes: every expanded group with at least one visible member below it.
	const boxMembers = new Map<string, string[]>();
	for (const n of nodes) {
		const g = isGroupNodeId(n.id) ? n.id.slice(GROUP_NODE_PREFIX.length) : groupOfNode(n.id);
		if (g === undefined) continue;
		for (const a of ancestry(g)) {
			if (isGroupNodeId(n.id) && a === g) continue; // a blob is not a member of its own (collapsed) group box
			boxMembers.set(a, [...(boxMembers.get(a) ?? []), n.id]);
		}
	}
	// `visited` guards a parent cycle in bad data from recursing forever.
	const levelOf = (groupId: string, visited: ReadonlySet<string> = new Set()): number => {
		const seen = new Set(visited).add(groupId);
		const kids = input.groups.filter((g) => g.parentGroupId === groupId && !seen.has(g.id) && boxMembers.has(g.id) && !input.collapsed.has(g.id));
		return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => levelOf(k.id, seen)));
	};
	const groupBoxes: ProjectedGroupBox[] = input.groups
		.filter((g) => boxMembers.has(g.id) && !input.collapsed.has(g.id))
		.map((g) => ({ id: g.id, label: g.name, level: levelOf(g.id), members: boxMembers.get(g.id)! }));

	return {
		nodes,
		edges: bundle(input.edges),
		logicalEdges: bundle(input.logicalEdges),
		impLinks,
		clusters,
		groupBoxes,
		blobIds,
	};
}
