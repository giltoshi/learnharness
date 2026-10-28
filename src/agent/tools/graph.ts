import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { getGraph, graphSessionIndex, graphSessionPropositions } from "../../core/graph.ts";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
import { sessionIdsInGroup } from "../../core/groups.ts";

/**
 * THE PROBER'S GRAPH TOOLS (wave 7, owner-locked 2026-09-23): context
 * injection is dead — zero configuration beyond chat models. The prober
 * reads the learner's persistent knowledge map through two tools instead,
 * replacing the old injected block with on-demand eyes.
 *
 * Names + levels + dating ONLY — no statement text, no session contents
 * (owner ruling: the map's ORGANIZATION is the prober's business, its
 * prose is not). The data comes from Platform's pure core seams
 * (graphSessionIndex / graphSessionPropositions) over the same ports the
 * snapshot reads, so the prober and the learner's graph view can never
 * disagree.
 *
 * Registered on the prober ONLY when the settings gate opens
 * (graphToolsEnabled — the graph master switch AND the agent.graphTools
 * toggle); the composition root decides, the factory just receives the
 * store (absent = the gate is closed, no map tools — tests drive this).
 */

/** What the graph tools close over: the stores the session views read. */
export interface GraphToolContext {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

const listSessionsInput = Type.Object({
	groupId: Type.Optional(Type.String({ description: "Only sessions in this group (subgroups included). Ids come from the group's owner; omit for all sessions." })),
});

const listPropositionsInput = Type.Object({
	session: Type.Optional(Type.String({
		minLength: 1,
		description: "The session's id exactly as list_sessions reported it (a chat id or a notes source id). Give this OR groupId.",
	})),
	groupId: Type.Optional(Type.String({ description: "A group id: lists the propositions born in every session in the group (subgroups included). Give this OR session." })),
});

/** Resolve a list_propositions request to the session ids it covers, or an error line. */
function sessionsFor(
	deps: { graphStore: GraphStore },
	input: { session?: string; groupId?: string },
): { ids: string[] } | { error: string } {
	if ((input.session === undefined) === (input.groupId === undefined)) {
		return { error: "Give exactly one of session or groupId." };
	}
	if (input.session !== undefined) return { ids: [input.session] };
	const groups = deps.graphStore.readGroups();
	if (!groups.groups.some((g) => g.id === input.groupId)) return { error: `No group "${input.groupId}".` };
	return { ids: sessionIdsInGroup(groups, input.groupId!) };
}

/** The group piece of a session line (before the id, so the id stays last); empty when ungrouped. */
const groupPiece = (s: { groupName: string | null }): string => (s.groupName ? ` — group: ${s.groupName}` : "");

type Deps = { chatStore: ChatStore; graphStore: GraphStore };

/** The group listing both tools share: per-session blocks of `linesFor(propositions)`. */
function groupListing(
	deps: Deps,
	groupId: string,
	ids: string[],
	linesFor: (propositions: ReturnType<typeof graphSessionPropositions>) => string,
): string {
	if (ids.length === 0) return `No sessions in group "${groupId}".`;
	const names = new Map(graphSessionIndex(deps).map((s) => [s.id, s.name]));
	let total = 0;
	const blocks: string[] = [];
	for (const id of ids) {
		const propositions = graphSessionPropositions(deps, id);
		if (propositions.length === 0) continue;
		total += propositions.length;
		blocks.push(`Session ${names.get(id) ?? id} (id: ${id}):\n${linesFor(propositions)}`);
	}
	if (blocks.length === 0) return `No propositions born in any session of group "${groupId}".`;
	return `${total} proposition(s) across ${blocks.length} session(s) in this group:\n${blocks.join("\n\n")}`;
}

export function proberGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	return {
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the sessions of the learner's persistent knowledge graph — every chat or imported-notes file that ever contributed a proposition, most recent first. The map is organized into birth-session clusters (propositions grouped by the session they were first learned in), and session names are those clusters' labels. " +
				"Each line: the session's name, kind (chat/file), how many propositions were born in it, its dates, and its id — use that id with list_propositions. " +
				"Reading this first shows what he has already covered and when, before you probe anything. " +
				"A session that sits in a group shows the group's name; pass groupId to list only that group's sessions (subgroups included).",
			parameters: listSessionsInput,
			execute: serverExecute("list_sessions", listSessionsInput, async ({ groupId }): Promise<string> => {
				const sessions = graphSessionIndex(deps, { groupId });
				if (sessions.length === 0 && groupId !== undefined) return `No sessions in group "${groupId}".`;
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) =>
					`${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"}, ` +
					`born ${s.createdAt ?? "unknown date"}${s.updatedAt ? `, last active ${s.updatedAt}` : ""})${groupPiece(s)} — id: ${s.id}`,
				);
				return `${sessions.length} session(s) in the knowledge graph, most recent first:\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one knowledge-graph session — what was covered there — or, with groupId, in every session of a group (subgroups included). " +
				"Names only — no statement text, no session contents (owner ruling 2026-09-23: the map's ORGANIZATION is your business, its prose is not).",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async (input): Promise<string> => {
				const resolved = sessionsFor(deps, input);
				if ("error" in resolved) return resolved.error;
				const namesOnly = (ps: ReturnType<typeof graphSessionPropositions>) => ps.map((p) => `- ${p.name}`).join("\n");
				if (input.session === undefined) return groupListing(deps, input.groupId!, resolved.ids, namesOnly);
				const propositions = graphSessionPropositions(deps, input.session);
				if (propositions.length === 0) {
					return `No propositions born in session "${input.session}". Call list_sessions for the current ids.`;
				}
				return `${propositions.length} proposition(s) covered in this session:\n${namesOnly(propositions)}`;
			}),
		},
	};
}

// ─── the auditor's graph tools (2026-09-27 relink) ───────────────────────────

/**
 * THE AUDITOR'S TOOLSET — the extraction auditor explores the graph to
 * place new propositions instead of receiving it injected (owner ruling
 * 2026-09-27: a full-graph dump bloats context as the graph grows; the
 * auditor looks up identity candidates itself). Auditor-specific
 * versions, deliberately different from the prober's:
 *
 *   find              glob over node names + statements + aliases — the
 *                     identity workhorse; returns id + name + statement
 *                     (statement text is ESSENTIAL for identity work,
 *                     unlike the prober's names-only rule).
 *   list_sessions     the birth-session index, no timestamps.
 *   list_propositions full proposition text (same reasoning as find).
 *
 * No timestamps anywhere: identity work needs content, not chronology.
 * Read-only, pure core seams, same ports the snapshot reads.
 */

/** Glob match — `*` spans anything, case-insensitive. `*needle*` is the
 *  expected shape; a bare term gets implicit surrounding stars. */
function globMatch(pattern: string, text: string): boolean {
	const raw = pattern.includes("*") ? pattern : `*${pattern}*`;
	const re = new RegExp(
		`^${raw.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "[\\s\\S]*" : `\\${ch}`))}$`,
		"i",
	);
	return re.test(text);
}

export function auditorGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };
	const findInput = Type.Object({
		query: Type.String({
			minLength: 1,
			description: "Glob pattern over node names, statements, and aliases — e.g. *will to power*. A bare term gets implicit surrounding *.",
		}),
	});
	return {
		find: {
			name: "find",
			label: "find",
			description:
				"Search the knowledge graph for existing propositions — glob over names, statements, and aliases. " +
				"Returns each match's id, name, full statement, and the session(s) it was born in (a list_propositions id). " +
				"This is how you decide whether a new proposition IS an existing one: search its key words, its synonyms, its phrasings.",
			parameters: findInput,
			execute: serverExecute("find", findInput, async ({ query }): Promise<string> => {
				const nodes = getGraph(deps.graphStore).nodes;
				const hits = nodes.filter(
					(n) => globMatch(query, n.name) || globMatch(query, n.statement) || n.aliases.some((a) => globMatch(query, a)),
				);
				if (hits.length === 0) return `No existing proposition matches "${query}".`;
				// BORN-IN POINTER (owner, 2026-09-29): a hit names its birth
				// session(s) — find results now compose with list_propositions
				// (read the whole session the hit came from) instead of being
				// dead ends. Legacy no-provenance nodes name none.
				const lines = hits.map((n) => {
					const born = [...new Set(n.provenance.map((pt) => pt.chatId))];
					return (
						`- ${n.id} :: ${n.name}\n  statement: ${n.statement}` +
						(born.length > 0 ? `\n  born in: ${born.join(", ")}` : "")
					);
				});
				return `${hits.length} match(es):\n${lines.join("\n")}`;
			}),
		},
		list_sessions: {
			name: "list_sessions",
			label: "list_sessions",
			description:
				"List the knowledge graph's birth sessions — every chat or imported-notes file that ever contributed a proposition. " +
				"Each line: name, kind, proposition count, group (when it sits in one), id. Use the id with list_propositions to see what a session covered; pass groupId to list only that group's sessions (subgroups included).",
			parameters: listSessionsInput,
			execute: serverExecute("list_sessions", listSessionsInput, async ({ groupId }): Promise<string> => {
				const sessions = graphSessionIndex(deps, { groupId });
				if (sessions.length === 0 && groupId !== undefined) return `No sessions in group "${groupId}".`;
				if (sessions.length === 0) return "The knowledge graph is empty — no session has contributed propositions yet.";
				const lines = sessions.map((s, i) => `${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? "" : "s"})${groupPiece(s)} — id: ${s.id}`);
				return `${sessions.length} session(s):\n${lines.join("\n")}`;
			}),
		},
		list_propositions: {
			name: "list_propositions",
			label: "list_propositions",
			description:
				"List the propositions BORN in one session (or, with groupId, in every session of a group, subgroups included), with FULL statement text — the content-level view for identity work " +
				"(deciding whether a new proposition is really one of these).",
			parameters: listPropositionsInput,
			execute: serverExecute("list_propositions", listPropositionsInput, async (input): Promise<string> => {
				const resolved = sessionsFor(deps, input);
				if ("error" in resolved) return resolved.error;
				const nodes = new Map(getGraph(deps.graphStore).nodes.map((n) => [n.id, n]));
				const withStatements = (ps: ReturnType<typeof graphSessionPropositions>) =>
					ps.map((p) => `- ${p.nodeId} :: ${p.name}\n  statement: ${nodes.get(p.nodeId)?.statement ?? "(unknown)"}`).join("\n");
				if (input.session === undefined) return groupListing(deps, input.groupId!, resolved.ids, withStatements);
				const propositions = graphSessionPropositions(deps, input.session);
				if (propositions.length === 0) return `No propositions born in session "${input.session}". Call list_sessions for the current ids.`;
				return `${propositions.length} proposition(s) born in this session:\n${withStatements(propositions)}`;
			}),
		},
	};
}
