# Session Groups and Folder Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the learner group birth-session clusters (a chat or an imported notes file) into nestable named groups, collapse a group into one blob on the graph canvas, and auto-create a group tree when a vault folder is dropped in.

**Architecture:** Groups are metadata only, stored in `data/graph/groups.json` (`groups` + a `sessionGroups` map of session id to group id). Node and chain ledgers are never touched. Pure core logic (`src/core/groups.ts`, `group-ops.ts`, `folder-groups.ts`) sits behind the `GraphStore` port; HTTP routes, agent tools and the UI are thin callers of it. Collapse is a pure projection (`components/group-projection.ts`) applied to the snapshot before it is fed to the canvas renderer, so the renderer only gains a group-box draw pass.

**Tech Stack:** Next.js (breaking-changes fork, see AGENTS.md), React, TypeScript, `node:test` run through `tsx`, typebox for agent tool schemas, Canvas 2D renderer in `components/graph-canvas.ts`.

## Global Constraints

Copied from the approved spec (`docs/superpowers/specs/2026-10-27-session-groups-design.md`) and the owner's answers:

- A group contains sessions (chat ids or `src_...` notes source ids), never individual nodes. A session belongs to at most one group.
- Groups nest through `parentGroupId`; mutations reject cycles.
- Node and chain ledgers are not modified. Merges and deletes leave groups alone. An empty group stays until deleted. Deleting a chat session removes its `sessionGroups` entry.
- Deleting a group re-parents its subgroups **and its directly-held sessions** to the deleted group's parent; with no parent, its sessions become ungrouped.
- Bump `CURRENT_GRAPH_FORMAT_VERSION` so older builds refuse the data.
- Agent group tools are on the **teacher**, behind the existing `graphToolsEnabled` gate. The prober and auditor stay read-only (they gain a group filter and a group label only).
- `delete_group` is a two-step confirm enforced in code: a call without a token returns a preview and a one-time token; the group is deleted only when called again with that token.
- Mutating tools return counts, e.g. `Moved 12 sessions (340 nodes) into 'Risk & Return'. 0 chains affected.`
- No undo stack. Every operation is reversible by its inverse.
- Folder import: the client sends relative paths; a dropped file whose bare name matches exactly one existing bare-name source reuses that source (placed in the group, not re-extracted); ambiguous matches import as new.
- Graph view: collapse and expand in place, chains bundled to the blob, cross-group chains stay visible. Group management lives in a Groups panel.
- Project rule (AGENTS.md): no guessing. If any step meets an ambiguity this plan does not resolve, stop and ask the owner.

## Assumptions to confirm at plan review

These are not in the approved spec; they are the plan's defaults:

1. Groups start expanded on every load (collapse state is not persisted).
2. The `groupId` filter on the read tools includes subgroups (deep).
3. Folder import imports only `.md`, `.markdown`, `.txt` (the existing picker's accept list) and skips any file or directory whose name starts with `.` (e.g. `.obsidian`, `.git`).
4. Folder import shows no confirmation dialog (matches the existing import).
5. Re-dropping a folder reuses groups with the same name under the same parent; files whose exact relative path was already imported are re-extracted (existing behavior).
6. The format version bump is 1 to 2, which requires updating two assertions in `tests/schema-stamps.test.ts`.
7. Folder drop is wired into the graph view only, not `components/minimal-home.tsx`.

## File Structure

| File | Responsibility |
|---|---|
| `src/core/contracts/graph.ts` (modify) | `GraphGroup`, `GroupsState` types; `groups` + `sessionGroups` on `GraphSnapshot`; format version 2 |
| `src/core/groups.ts` (create) | Pure group state operations and `GroupError` |
| `src/core/group-ops.ts` (create) | Operations over ports with counts and messages; the one layer HTTP and tools both call |
| `src/core/folder-groups.ts` (create) | Pure folder-path to group-tree planning and bare-name source matching |
| `src/core/ports.ts` (modify) | `GraphStore.readGroups/writeGroups` |
| `config.ts` (modify) | `GROUPS_FILE` |
| `src/store/graph.ts` (modify) | groups.json adapter |
| `src/core/graph.ts` (modify) | snapshot fields; `graphSessionIndex` group fields and filter |
| `src/server/groups.ts` (create) | HTTP response wrappers around `group-ops` |
| `app/api/graph/groups/route.ts`, `app/api/graph/groups/[id]/route.ts`, `app/api/graph/groups/sessions/route.ts` (create) | Group HTTP API |
| `src/server/graph.ts`, `src/server/chats.ts` (modify) | revision includes groups file; prune on chat delete |
| `app/api/graph/import/route.ts`, `components/notes-import.tsx` (modify) | relative paths, folder groups, reuse |
| `src/agent/tools/groups.ts` (create) | Teacher group tools |
| `src/agent/tools/graph.ts`, `src/agent/tools.ts`, `src/server/chat-handler.ts` (modify) | read-tool group filter; teacher registration |
| `components/group-projection.ts` (create) | Pure collapse projection |
| `components/graph-canvas.ts` (modify) | `groupBoxes` draw pass, `boxBounds` |
| `components/group-tree.ts`, `components/groups-client.ts`, `components/groups-panel.tsx` (create) | Groups panel |
| `components/folder-import.ts` (create) | Folder picker/drop collection and filtering |
| `components/graph-view.tsx` (modify) | wiring |

Run a single test file with: `NODE_ENV=test npx tsx --test tests/<file>.test.ts`. Full suite: `npm test`. Typecheck: `npm run typecheck`.

---

### Task 1: Group types and pure state operations

**Files:**
- Modify: `src/core/contracts/graph.ts` (after `NotesSource`, near line 105; version constant at line 123)
- Create: `src/core/groups.ts`
- Test: `tests/groups.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `interface GraphGroup { id: string; name: string; parentGroupId?: string }`
  - `interface GroupsState { groups: GraphGroup[]; sessionGroups: Record<string, string> }`
  - `class GroupError extends Error { code: GroupErrorCode }`, `type GroupErrorCode = "invalid_name" | "unknown_group" | "unknown_parent" | "cycle" | "unknown_session"`
  - `emptyGroups(): GroupsState`, `cleanGroupName(raw: string): string`, `GROUP_NAME_MAX = 80`
  - `createGroup(state, { id, name, parentGroupId? }): GroupsState`
  - `renameGroup(state, id, name): GroupsState`
  - `setGroupParent(state, id, parentGroupId: string | null): GroupsState`
  - `addSessionsToGroup(state, groupId, sessionIds): { state; moved: string[]; unchanged: string[] }`
  - `removeSessionsFromGroup(state, sessionIds): { state; removed: string[]; unchanged: string[] }`
  - `deleteGroup(state, id): { state; reparentedGroups: string[]; reparentedSessions: string[]; ungroupedSessions: string[] }`
  - `pruneSession(state, sessionId): GroupsState`
  - `descendantGroupIds(state, groupId): string[]`, `sessionIdsInGroup(state, groupId, deep = true): string[]`
  - `groupPathLabel(groups, id): string` (names joined with `" / "`)

- [ ] **Step 1: Add the types and bump the version**

In `src/core/contracts/graph.ts`, directly after the `NotesSource` interface add:

```ts
/** One session group (data/graph/groups.json). Groups are METADATA ONLY:
 *  they never touch the node or chain ledgers. */
export interface GraphGroup {
	id: string;
	name: string;
	/** Absent = a top-level group. */
	parentGroupId?: string;
}

/** The whole groups file. `sessionGroups` maps a session id (a chat id or
 *  a notes source id "src_…") to the ONE group it belongs to. */
export interface GroupsState {
	groups: GraphGroup[];
	sessionGroups: Record<string, string>;
}
```

Change `export const CURRENT_GRAPH_FORMAT_VERSION = 1;` to `= 2;` and extend its doc comment with one line: `v2 (2026-10-27): adds groups.json (session groups).`

- [ ] **Step 2: Write the failing tests**

Create `tests/groups.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	addSessionsToGroup,
	cleanGroupName,
	createGroup,
	deleteGroup,
	descendantGroupIds,
	emptyGroups,
	GroupError,
	groupPathLabel,
	pruneSession,
	removeSessionsFromGroup,
	renameGroup,
	sessionIdsInGroup,
	setGroupParent,
} from "../src/core/groups.ts";

const tree = () => {
	let s = emptyGroups();
	s = createGroup(s, { id: "g_fina", name: "FINA 411" });
	s = createGroup(s, { id: "g_risk", name: "Risk", parentGroupId: "g_fina" });
	s = createGroup(s, { id: "g_other", name: "Other" });
	return s;
};

describe("cleanGroupName", () => {
	it("trims and collapses whitespace", () => {
		assert.equal(cleanGroupName("  FINA   411 "), "FINA 411");
	});
	it("rejects empty and over-long names", () => {
		assert.throws(() => cleanGroupName("   "), (e) => e instanceof GroupError && e.code === "invalid_name");
		assert.throws(() => cleanGroupName("x".repeat(81)), (e) => e instanceof GroupError && e.code === "invalid_name");
	});
});

describe("createGroup / renameGroup / setGroupParent", () => {
	it("creates nested groups and rejects an unknown parent", () => {
		const s = tree();
		assert.equal(s.groups.find((g) => g.id === "g_risk")?.parentGroupId, "g_fina");
		assert.throws(
			() => createGroup(s, { id: "g_x", name: "X", parentGroupId: "nope" }),
			(e) => e instanceof GroupError && e.code === "unknown_parent",
		);
	});
	it("renames", () => {
		assert.equal(renameGroup(tree(), "g_fina", " FINA 411 F26 ").groups[0]!.name, "FINA 411 F26");
		assert.throws(() => renameGroup(tree(), "nope", "x"), (e) => e instanceof GroupError && e.code === "unknown_group");
	});
	it("re-parents and rejects cycles", () => {
		const s = tree();
		assert.equal(setGroupParent(s, "g_other", "g_fina").groups.find((g) => g.id === "g_other")?.parentGroupId, "g_fina");
		assert.equal(setGroupParent(s, "g_risk", null).groups.find((g) => g.id === "g_risk")?.parentGroupId, undefined);
		assert.throws(() => setGroupParent(s, "g_fina", "g_risk"), (e) => e instanceof GroupError && e.code === "cycle");
		assert.throws(() => setGroupParent(s, "g_fina", "g_fina"), (e) => e instanceof GroupError && e.code === "cycle");
	});
});

describe("session membership", () => {
	it("moves sessions, including ones already in another group, and reports unchanged", () => {
		let s = addSessionsToGroup(tree(), "g_risk", ["a", "b"]).state;
		const r = addSessionsToGroup(s, "g_other", ["b", "c", "c"]);
		assert.deepEqual(r.moved, ["b", "c"]);
		assert.deepEqual(r.unchanged, []);
		assert.equal(r.state.sessionGroups.b, "g_other");
		const again = addSessionsToGroup(r.state, "g_other", ["b"]);
		assert.deepEqual(again.unchanged, ["b"]);
		assert.deepEqual(again.moved, []);
	});
	it("removes sessions from their group", () => {
		const s = addSessionsToGroup(tree(), "g_risk", ["a"]).state;
		const r = removeSessionsFromGroup(s, ["a", "zzz"]);
		assert.deepEqual(r.removed, ["a"]);
		assert.deepEqual(r.unchanged, ["zzz"]);
		assert.equal(r.state.sessionGroups.a, undefined);
	});
	it("lists a group's sessions deeply by default", () => {
		let s = addSessionsToGroup(tree(), "g_risk", ["a"]).state;
		s = addSessionsToGroup(s, "g_fina", ["b"]).state;
		assert.deepEqual(sessionIdsInGroup(s, "g_fina"), ["a", "b"]);
		assert.deepEqual(sessionIdsInGroup(s, "g_fina", false), ["b"]);
		assert.deepEqual(descendantGroupIds(s, "g_fina"), ["g_risk"]);
	});
	it("prunes one session", () => {
		const s = addSessionsToGroup(tree(), "g_risk", ["a", "b"]).state;
		assert.deepEqual(pruneSession(s, "a").sessionGroups, { b: "g_risk" });
		assert.equal(pruneSession(s, "zzz"), s);
	});
});

describe("deleteGroup", () => {
	it("re-parents subgroups and held sessions to the parent", () => {
		let s = addSessionsToGroup(tree(), "g_risk", ["a"]).state;
		s = createGroup(s, { id: "g_deep", name: "Deep", parentGroupId: "g_risk" });
		const r = deleteGroup(s, "g_risk");
		assert.deepEqual(r.reparentedGroups, ["g_deep"]);
		assert.deepEqual(r.reparentedSessions, ["a"]);
		assert.equal(r.state.groups.find((g) => g.id === "g_deep")?.parentGroupId, "g_fina");
		assert.equal(r.state.sessionGroups.a, "g_fina");
		assert.equal(r.state.groups.some((g) => g.id === "g_risk"), false);
	});
	it("ungroups sessions of a top-level group and lifts its subgroups to top level", () => {
		const s = addSessionsToGroup(tree(), "g_fina", ["a"]).state;
		const r = deleteGroup(s, "g_fina");
		assert.deepEqual(r.ungroupedSessions, ["a"]);
		assert.equal(r.state.sessionGroups.a, undefined);
		assert.equal("parentGroupId" in r.state.groups.find((g) => g.id === "g_risk")!, false);
	});
});

describe("groupPathLabel", () => {
	it("joins ancestor names", () => {
		assert.equal(groupPathLabel(tree().groups, "g_risk"), "FINA 411 / Risk");
		assert.equal(groupPathLabel(tree().groups, "g_other"), "Other");
	});
});
```

- [ ] **Step 3: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/groups.test.ts`
Expected: FAIL (cannot find module `../src/core/groups.ts`).

- [ ] **Step 4: Implement `src/core/groups.ts`**

```ts
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
```

- [ ] **Step 5: Run and verify pass**

Run: `NODE_ENV=test npx tsx --test tests/groups.test.ts`
Expected: PASS (all suites green).

- [ ] **Step 6: Commit**

```bash
git add src/core/contracts/graph.ts src/core/groups.ts tests/groups.test.ts
git commit -m "feat(groups): group types and pure state operations"
```

---

### Task 2: Storage (groups.json), format stamp v2, revision

**Files:**
- Modify: `config.ts` (after `POSITIONS_FILE`, line 81), `src/core/ports.ts` (`GraphStore`, line 76-129), `src/store/graph.ts`, `src/server/graph.ts` (`graphRevision`, line 66)
- Modify: `tests/schema-stamps.test.ts` (lines 90 and 107)
- Test: `tests/groups-store.test.ts`

**Interfaces:**
- Consumes: `GroupsState`, `emptyGroups` (Task 1).
- Produces: `GraphStore.readGroups(): GroupsState`, `GraphStore.writeGroups(state: GroupsState): void`, `GROUPS_FILE` constant.

- [ ] **Step 1: Write the failing store test**

Create `tests/groups-store.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// The data-dir seam BEFORE any config-loading import (schema-stamps discipline).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-groups-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { graphStore } = await import("../src/store/graph.ts");
const { GROUPS_FILE, GRAPH_FORMAT_FILE } = await import("../config.ts");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

test("no groups file reads as empty and does not stamp the family", () => {
	assert.deepEqual(graphStore.readGroups(), { groups: [], sessionGroups: {} });
	assert.ok(!fs.existsSync(GROUPS_FILE));
	assert.ok(!fs.existsSync(GRAPH_FORMAT_FILE));
});

test("writeGroups round-trips and stamps the family at the current version", () => {
	graphStore.writeGroups({
		groups: [{ id: "g1", name: "FINA 411" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
		sessionGroups: { src_a: "g2" },
	});
	assert.deepEqual(graphStore.readGroups(), {
		groups: [{ id: "g1", name: "FINA 411" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
		sessionGroups: { src_a: "g2" },
	});
	assert.equal(JSON.parse(fs.readFileSync(GRAPH_FORMAT_FILE, "utf8")).version, 2);
});

test("reads drop malformed groups and session entries pointing at unknown groups", () => {
	fs.writeFileSync(
		GROUPS_FILE,
		JSON.stringify({ groups: [{ id: "g1", name: "ok" }, { id: 5 }, "junk"], sessionGroups: { a: "g1", b: "ghost", c: 7 } }),
		"utf-8",
	);
	assert.deepEqual(graphStore.readGroups(), { groups: [{ id: "g1", name: "ok" }], sessionGroups: { a: "g1" } });
});

test("a corrupt file reads as empty, never throws", () => {
	fs.writeFileSync(GROUPS_FILE, "{not json", "utf-8");
	assert.deepEqual(graphStore.readGroups(), { groups: [], sessionGroups: {} });
});

test("a NEWER-stamped family refuses reads honestly", () => {
	fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: 99 }), "utf-8");
	assert.throws(() => graphStore.readGroups(), /format version 99/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/groups-store.test.ts`
Expected: FAIL (`GROUPS_FILE` undefined / `readGroups` not a function).

- [ ] **Step 3: Add the config constant**

In `config.ts` after the `POSITIONS_FILE` export add:

```ts
/** Session groups (src/core/groups.ts): ONE JSON file, read-modify-write
 *  like sources.json — { groups, sessionGroups }. Metadata only; the
 *  ledgers never reference it. Versioned by the format.json family stamp. */
export const GROUPS_FILE = path.join(PATHS.graph, "groups.json");
```

Also extend the `GRAPH_FORMAT_FILE` doc comment: add `groups.json` to the list of family files.

- [ ] **Step 4: Extend the port**

In `src/core/ports.ts`, add to the type imports `GroupsState` and inside `GraphStore` after `writePositions`:

```ts
	/** The session-groups file (config.GROUPS_FILE — a JSON file, not a
	 *  ledger): groups + session membership. Reads never write; an absent
	 *  or corrupt file reads as empty. */
	readGroups(): GroupsState;
	/** Replace the whole file (atomic temp + rename). */
	writeGroups(state: GroupsState): void;
```

- [ ] **Step 5: Implement the adapter**

In `src/store/graph.ts`: add `GROUPS_FILE` to the `config.ts` import, `GraphGroup, GroupsState` to the contracts type import, and `import { emptyGroups } from "../core/groups.ts";`. Add to `graphStore` after `writePositions`:

```ts
	readGroups(): GroupsState {
		return readGroupsFile();
	},
	writeGroups(state: GroupsState): void {
		writeGroupsFile(state);
	},
```

Add after `writePositionMap`:

```ts
const isGroup = (v: unknown): v is GraphGroup =>
	isRecord(v) && isString(v.id) && isString(v.name) && (v.parentGroupId === undefined || isString(v.parentGroupId));

/** groups.json — { groups, sessionGroups }. Read-modify-write. Shape-guarded
 *  like every graph-family read: junk entries are dropped, never guessed at;
 *  a session entry pointing at an unknown group is dropped too. */
function readGroupsFile(): GroupsState {
	assertGraphFormat(); // honest refusal on a newer-stamped data dir
	let raw: string;
	try {
		raw = fs.readFileSync(GROUPS_FILE, "utf-8");
	} catch {
		return emptyGroups();
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return emptyGroups();
		const groups = Array.isArray(parsed.groups) ? parsed.groups.filter(isGroup) : [];
		const ids = new Set(groups.map((g) => g.id));
		const sessionGroups: Record<string, string> = {};
		if (isRecord(parsed.sessionGroups)) {
			for (const [sessionId, groupId] of Object.entries(parsed.sessionGroups)) {
				if (isString(groupId) && ids.has(groupId)) sessionGroups[sessionId] = groupId;
			}
		}
		return { groups, sessionGroups };
	} catch {
		return emptyGroups();
	}
}

function writeGroupsFile(state: GroupsState): void {
	fs.mkdirSync(path.dirname(GROUPS_FILE), { recursive: true });
	ensureGraphFormat(); // the lazy format stamp (graph-format.ts)
	const tmp = `${GROUPS_FILE}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(state, null, "\t"), "utf-8");
		fs.renameSync(tmp, GROUPS_FILE);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename either already happened or the tmp never existed */
		}
		throw err;
	}
}
```

- [ ] **Step 6: Revision includes the groups file**

In `src/server/graph.ts` `graphRevision()`, add `GROUPS_FILE` to the file list and to the `config.ts` import (`import { GROUPS_FILE, LEDGER_FILES, POSITIONS_FILE } from "../../config.ts";`).

- [ ] **Step 7: Update the stamp assertions**

In `tests/schema-stamps.test.ts` change the two `.version, 1` assertions at lines 90 and 107 to `2`, and in their messages/titles replace "v1" wording for the graph family only if it says the graph is v1 (leave the chats assertions, which stay at 1).

- [ ] **Step 8: Run tests**

Run: `NODE_ENV=test npx tsx --test tests/groups-store.test.ts tests/schema-stamps.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add config.ts src/core/ports.ts src/store/graph.ts src/server/graph.ts tests/groups-store.test.ts tests/schema-stamps.test.ts
git commit -m "feat(groups): groups.json store, format stamp v2, revision signal"
```

---

### Task 3: Snapshot and read-side session views carry groups

**Files:**
- Modify: `src/core/contracts/graph.ts` (`GraphSnapshot`), `src/core/graph.ts` (`graphSnapshot` line 509, `GraphSessionEntry` line 609, `graphSessionIndex` line 630)
- Modify: any test fake `GraphStore` that now fails (see Step 5)
- Test: `tests/groups-snapshot.test.ts`

**Interfaces:**
- Consumes: `GraphStore.readGroups` (Task 2), `sessionIdsInGroup`, `groupPathLabel` (Task 1).
- Produces:
  - `GraphSnapshot.groups: GraphGroup[]`, `GraphSnapshot.sessionGroups: Record<string, string>`
  - `GraphSessionEntry.groupId: string | null`, `GraphSessionEntry.groupName: string | null` (path label)
  - `graphSessionIndex(deps, filter?: { groupId?: string }): GraphSessionEntry[]` (the filter is deep and unknown group yields `[]`)

- [ ] **Step 1: Write the failing test**

Create `tests/groups-snapshot.test.ts` (model the in-memory fakes on `tests/session-clusters.test.ts` lines 1-80; copy its `node`, `pt` helpers and its `fakeDeps` builder, adding `readGroups`). Cases:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphNode, GroupsState } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { graphSessionIndex, graphSnapshot } from "../src/core/graph.ts";

const pt = (chatId: string) => ({ chatId, messageId: "m1" });
const node = (id: string, chatId: string): GraphNode => ({
	id, name: id, statement: `${id} s`, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [pt(chatId)],
});

function deps(groups: GroupsState) {
	const nodes = [node("n1", "src_a"), node("n2", "src_a"), node("n3", "src_a"), node("n4", "src_b")];
	const graphStore = {
		readNodes: () => nodes, readChains: () => [], readCheckpoints: () => [], readCoverage: () => [],
		readSources: () => [
			{ id: "src_a", filePath: "FINA 411/Ch 01.md", importedAt: "2026-10-02T00:00:00.000Z" },
			{ id: "src_b", filePath: "Other.md", importedAt: "2026-10-01T00:00:00.000Z" },
		],
		readPositions: () => ({}), readGroups: () => groups,
	} as unknown as GraphStore;
	const chatStore = { listChats: () => [], getChat: () => undefined } as unknown as ChatStore;
	return { chatStore, graphStore };
}

const groups: GroupsState = {
	groups: [{ id: "g1", name: "FINA 411" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
	sessionGroups: { src_a: "g2" },
};

describe("snapshot carries groups", () => {
	it("exposes groups and the session map verbatim", () => {
		const snap = graphSnapshot(deps(groups));
		assert.deepEqual(snap.groups, groups.groups);
		assert.deepEqual(snap.sessionGroups, groups.sessionGroups);
	});
	it("empty groups file gives empty fields", () => {
		const snap = graphSnapshot(deps({ groups: [], sessionGroups: {} }));
		assert.deepEqual(snap.groups, []);
		assert.deepEqual(snap.sessionGroups, {});
	});
});

describe("graphSessionIndex groups", () => {
	it("labels each session with its group path", () => {
		const idx = graphSessionIndex(deps(groups));
		assert.equal(idx.find((s) => s.id === "src_a")?.groupName, "FINA 411 / Risk");
		assert.equal(idx.find((s) => s.id === "src_b")?.groupId, null);
	});
	it("filters by group deeply", () => {
		assert.deepEqual(graphSessionIndex(deps(groups), { groupId: "g1" }).map((s) => s.id), ["src_a"]);
		assert.deepEqual(graphSessionIndex(deps(groups), { groupId: "nope" }), []);
	});
});
```

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/groups-snapshot.test.ts`
Expected: FAIL (`snap.groups` undefined).

- [ ] **Step 3: Implement**

In `src/core/contracts/graph.ts` add to `GraphSnapshot` (after `clusters`):

```ts
	/** The session groups (data/graph/groups.json) and each session's
	 *  group — what the canvas projects into group boxes / collapsed blobs
	 *  and the Groups panel lists. Metadata only. */
	groups: GraphGroup[];
	sessionGroups: Record<string, string>;
```

In `src/core/graph.ts`: import `groupPathLabel, sessionIdsInGroup` from `./groups.ts`. In `graphSnapshot`, before the `return`, add `const { groups, sessionGroups } = deps.graphStore.readGroups();` and include `groups, sessionGroups,` in the returned object (after `clusters,`).

Extend `GraphSessionEntry` with:

```ts
	/** The session's group id (data/graph/groups.json), or null. */
	groupId: string | null;
	/** The group's path label ("FINA 411 / Risk"), or null. */
	groupName: string | null;
```

Change `graphSessionIndex` signature to `(deps: GraphDeps, filter: { groupId?: string } = {})`. At the top read `const groups = deps.graphStore.readGroups();`, `const allowed = filter.groupId === undefined ? null : new Set(sessionIdsInGroup(groups, filter.groupId));`. Inside the `for (const [id, propositions] of counts)` loop, add `if (allowed && !allowed.has(id)) continue;` as its first statement, and in both `entries.push({...})` calls add:

```ts
				groupId: groups.sessionGroups[id] ?? null,
				groupName: groups.sessionGroups[id] === undefined ? null : groupPathLabel(groups.groups, groups.sessionGroups[id]!),
```

- [ ] **Step 4: Run and verify pass**

Run: `NODE_ENV=test npx tsx --test tests/groups-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Repair existing fakes and run the whole suite**

Run: `npm run typecheck` then `npm test`.
Expected failures: tests whose in-memory `GraphStore` lacks `readGroups` (known: `tests/graph-tools.test.ts`, `tests/session-clusters.test.ts`; others may surface). For each, add `readGroups: () => ({ groups: [], sessionGroups: {} }),` to the fake. Fix any snapshot deep-equal assertions by adding `groups: [], sessionGroups: {}`. Re-run until green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(groups): snapshot and session index carry groups"
```

---

### Task 4: Group operations with counts, HTTP API, chat-delete pruning

**Files:**
- Create: `src/core/group-ops.ts`, `src/server/groups.ts`, `app/api/graph/groups/route.ts`, `app/api/graph/groups/[id]/route.ts`, `app/api/graph/groups/sessions/route.ts`
- Modify: `src/server/index.ts`, `src/server/chats.ts` (`deleteChatSession`, line 127-133)
- Test: `tests/group-ops.test.ts`

**Interfaces:**
- Consumes: Task 1 operations; `GraphDeps` (`src/core/graph.ts` line 73); `getGraph`; `birthSessionPartition`.
- Produces (`src/core/group-ops.ts`), all take `deps: GraphDeps` first and throw `GroupError`:
  - `createGroupOp(deps, { name, parentGroupId?, sessionIds? }): { groupId; movedSessions: number; nodes: number; chainsAffected: 0; message: string }`
  - `addSessionsOp(deps, groupId, sessionIds): { movedSessions; unchangedSessions; nodes; chainsAffected: 0; message }`
  - `removeSessionsOp(deps, sessionIds): { removedSessions; nodes; chainsAffected: 0; message }`
  - `renameGroupOp(deps, groupId, name): { message }`
  - `setGroupParentOp(deps, groupId, parentGroupId | null): { message }`
  - `previewDeleteGroupOp(deps, groupId): { message }` (no write)
  - `deleteGroupOp(deps, groupId): { reparentedGroups; reparentedSessions; ungroupedSessions; chainsAffected: 0; message }`
  - `listGroupsOp(deps): { id; name; path; parentGroupId: string | null; sessions: number; nodes: number }[]` (counts deep, sorted by path)
  - `pruneSessionOp(graphStore, sessionId): void`

- [ ] **Step 1: Write the failing tests**

Create `tests/group-ops.test.ts` using an in-memory store that actually keeps state:

```ts
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GraphNode, GroupsState } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { GroupError } from "../src/core/groups.ts";
import {
	addSessionsOp, createGroupOp, deleteGroupOp, listGroupsOp, previewDeleteGroupOp,
	pruneSessionOp, removeSessionsOp, renameGroupOp, setGroupParentOp,
} from "../src/core/group-ops.ts";

const pt = (chatId: string) => ({ chatId, messageId: "m1" });
const node = (id: string, chatId: string): GraphNode => ({
	id, name: id, statement: `${id} s`, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [pt(chatId)],
});

let state: GroupsState;
let writes: number;
const nodes = [node("a1", "src_a"), node("a2", "src_a"), node("a3", "src_a"), node("b1", "src_b"), node("b2", "src_b")];
const graphStore = {
	readNodes: () => nodes, readChains: () => [], readCheckpoints: () => [], readCoverage: () => [],
	readSources: () => [
		{ id: "src_a", filePath: "A.md", importedAt: "2026-10-01T00:00:00.000Z" },
		{ id: "src_b", filePath: "B.md", importedAt: "2026-10-01T00:00:00.000Z" },
	],
	readPositions: () => ({}),
	readGroups: () => state,
	writeGroups: (s: GroupsState) => { state = s; writes++; },
} as unknown as GraphStore;
const chatStore = { listChats: () => [], getChat: () => undefined } as unknown as ChatStore;
const deps = { chatStore, graphStore };

beforeEach(() => { state = { groups: [], sessionGroups: {} }; writes = 0; });

describe("createGroupOp", () => {
	it("creates, optionally fills, and reports counts", () => {
		const r = createGroupOp(deps, { name: "Risk & Return", sessionIds: ["src_a", "src_b"] });
		assert.equal(r.movedSessions, 2);
		assert.equal(r.nodes, 5);
		assert.equal(r.chainsAffected, 0);
		assert.equal(r.message, `Created group 'Risk & Return' (${r.groupId}). Moved 2 sessions (5 nodes) into it. 0 chains affected.`);
		assert.equal(state.sessionGroups.src_a, r.groupId);
	});
	it("rejects unknown sessions without writing", () => {
		assert.throws(() => createGroupOp(deps, { name: "X", sessionIds: ["ghost"] }), (e) => e instanceof GroupError && e.code === "unknown_session");
		assert.equal(writes, 0);
	});
});

describe("move / remove / rename / parent", () => {
	it("moves between groups and reports unchanged", () => {
		const a = createGroupOp(deps, { name: "A" }).groupId;
		const b = createGroupOp(deps, { name: "B" }).groupId;
		addSessionsOp(deps, a, ["src_a"]);
		const r = addSessionsOp(deps, b, ["src_a", "src_b"]);
		assert.equal(r.message, "Moved 2 sessions (5 nodes) into 'B'. 0 chains affected.");
		const again = addSessionsOp(deps, b, ["src_a"]);
		assert.equal(again.message, "Moved 0 sessions (0 nodes) into 'B'; 1 already there. 0 chains affected.");
	});
	it("removes", () => {
		const a = createGroupOp(deps, { name: "A", sessionIds: ["src_a"] }).groupId;
		const r = removeSessionsOp(deps, ["src_a", "src_b"]);
		assert.equal(r.message, "Removed 1 session (3 nodes) from their groups. 0 chains affected. 1 was not in a group.");
		assert.equal(state.sessionGroups.src_a, undefined);
		assert.ok(a);
	});
	it("renames and re-parents", () => {
		const a = createGroupOp(deps, { name: "A" }).groupId;
		const b = createGroupOp(deps, { name: "B" }).groupId;
		assert.equal(renameGroupOp(deps, a, "Alpha").message, "Renamed group 'A' to 'Alpha'.");
		assert.equal(setGroupParentOp(deps, b, a).message, "Moved group 'B' into 'Alpha'.");
		assert.equal(setGroupParentOp(deps, b, null).message, "Moved group 'B' to the top level.");
		assert.throws(() => setGroupParentOp(deps, a, a), (e) => e instanceof GroupError && e.code === "cycle");
	});
});

describe("delete", () => {
	it("previews without writing, then deletes with counts", () => {
		const a = createGroupOp(deps, { name: "A", sessionIds: ["src_a"] }).groupId;
		writes = 0;
		assert.equal(previewDeleteGroupOp(deps, a).message, "Deleting group 'A' would leave 1 session ungrouped and move 0 subgroups.");
		assert.equal(writes, 0);
		const r = deleteGroupOp(deps, a);
		assert.equal(r.message, "Deleted group 'A'. 1 session left ungrouped, 0 subgroups moved up. 0 chains affected.");
		assert.deepEqual(state, { groups: [], sessionGroups: {} });
	});
});

describe("listGroupsOp / pruneSessionOp", () => {
	it("lists deep counts sorted by path", () => {
		const a = createGroupOp(deps, { name: "FINA", sessionIds: ["src_b"] }).groupId;
		const b = createGroupOp(deps, { name: "Risk", parentGroupId: a, sessionIds: ["src_a"] }).groupId;
		const list = listGroupsOp(deps);
		assert.deepEqual(list.map((g) => [g.path, g.sessions, g.nodes]), [["FINA", 2, 5], ["FINA / Risk", 1, 3]]);
		assert.equal(list[1]!.id, b);
		assert.equal(list[1]!.parentGroupId, a);
	});
	it("prunes only when the session was grouped", () => {
		createGroupOp(deps, { name: "A", sessionIds: ["src_a"] });
		writes = 0;
		pruneSessionOp(graphStore, "src_b");
		assert.equal(writes, 0);
		pruneSessionOp(graphStore, "src_a");
		assert.equal(writes, 1);
		assert.deepEqual(state.sessionGroups, {});
	});
});
```

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/group-ops.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/core/group-ops.ts`**

```ts
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
	addSessionsToGroup, cleanGroupName, createGroup, deleteGroup, descendantGroupIds, GroupError,
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

export { descendantGroupIds };
```

(Remove the trailing `export { descendantGroupIds };` and the unused import if lint flags them.)

- [ ] **Step 4: Run and verify pass**

Run: `NODE_ENV=test npx tsx --test tests/group-ops.test.ts`
Expected: PASS. If a message assertion differs by punctuation, fix the implementation to match the test strings above (they are the spec'd wording).

- [ ] **Step 5: HTTP wrappers and routes**

Create `src/server/groups.ts`:

```ts
import * as ops from "../core/group-ops.ts";
import { GroupError } from "../core/groups.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";

/** Group-operation HTTP outcome: GroupError maps to 4xx, success carries the
 *  new graphRevision (the refetch signal every graph listener follows). */
export interface GroupHttp {
	status: number;
	body: Record<string, unknown>;
}

function respond(run: () => object): GroupHttp {
	try {
		return { status: 200, body: { ...run(), graphRevision: graphRevision() } };
	} catch (err) {
		if (err instanceof GroupError) {
			return { status: err.code === "unknown_group" ? 404 : 400, body: { error: err.message, code: err.code } };
		}
		throw err;
	}
}

export const groupApi = {
	create: (input: { name: string; parentGroupId?: string; sessionIds?: string[] }) => respond(() => ops.createGroupOp(stores, input)),
	rename: (id: string, name: string) => respond(() => ops.renameGroupOp(stores, id, name)),
	setParent: (id: string, parentGroupId: string | null) => respond(() => ops.setGroupParentOp(stores, id, parentGroupId)),
	remove: (id: string) => respond(() => ops.deleteGroupOp(stores, id)),
	moveSessions: (groupId: string | null, sessionIds: string[]) =>
		respond(() => (groupId === null ? ops.removeSessionsOp(stores, sessionIds) : ops.addSessionsOp(stores, groupId, sessionIds))),
};
```

Add `export * from "./groups.ts";` to `src/server/index.ts` beside `export * from "./graph.ts";`.

Create `app/api/graph/groups/route.ts`:

```ts
import { groupApi } from "@/src/server";

export const dynamic = "force-dynamic";

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** POST /api/graph/groups — { name, parentGroupId?, sessionIds? } → 200 { groupId, ... } */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body.name !== "string") return Response.json({ error: "name is required" }, { status: 400 });
	if (body.parentGroupId !== undefined && typeof body.parentGroupId !== "string") return Response.json({ error: "parentGroupId must be a string" }, { status: 400 });
	if (body.sessionIds !== undefined && !isStringArray(body.sessionIds)) return Response.json({ error: "sessionIds must be a string array" }, { status: 400 });
	const out = groupApi.create({ name: body.name, parentGroupId: body.parentGroupId as string | undefined, sessionIds: body.sessionIds as string[] | undefined });
	return Response.json(out.body, { status: out.status });
}
```

Create `app/api/graph/groups/[id]/route.ts`:

```ts
import { groupApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** PATCH { name? , parentGroupId? (string | null) } — rename and/or move. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) return Response.json({ error: "invalid JSON body" }, { status: 400 });
	if (body.name !== undefined && typeof body.name !== "string") return Response.json({ error: "name must be a string" }, { status: 400 });
	if (body.parentGroupId !== undefined && body.parentGroupId !== null && typeof body.parentGroupId !== "string") {
		return Response.json({ error: "parentGroupId must be a string or null" }, { status: 400 });
	}
	if (body.name === undefined && body.parentGroupId === undefined) return Response.json({ error: "nothing to change" }, { status: 400 });
	let out = { status: 200, body: {} as Record<string, unknown> };
	if (typeof body.name === "string") out = groupApi.rename(id, body.name);
	if (out.status === 200 && body.parentGroupId !== undefined) out = groupApi.setParent(id, body.parentGroupId as string | null);
	return Response.json(out.body, { status: out.status });
}

/** DELETE — the group goes; subgroups and held sessions move up (see core/groups.ts). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const out = groupApi.remove(id);
	return Response.json(out.body, { status: out.status });
}
```

Create `app/api/graph/groups/sessions/route.ts`:

```ts
import { groupApi } from "@/src/server";

export const dynamic = "force-dynamic";

/** PUT { groupId: string | null, sessionIds: string[] } — move sessions into a group (null = ungroup). */
export async function PUT(request: Request) {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const ids = body?.sessionIds;
	if (!body || !Array.isArray(ids) || !ids.every((x) => typeof x === "string") || ids.length === 0) {
		return Response.json({ error: "sessionIds must be a non-empty string array" }, { status: 400 });
	}
	if (body.groupId !== null && typeof body.groupId !== "string") return Response.json({ error: "groupId must be a string or null" }, { status: 400 });
	const out = groupApi.moveSessions(body.groupId as string | null, ids as string[]);
	return Response.json(out.body, { status: out.status });
}
```

- [ ] **Step 6: Prune on chat deletion**

In `src/server/chats.ts` add `import { pruneSessionOp } from "../core/group-ops.ts";` and inside `deleteChatSession`, directly after the `if (stores.chatStore.deleteChat(chatId)) { ... }` block and before `return { ok: true ... }`, add `pruneSessionOp(stores.graphStore, chatId);`.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && NODE_ENV=test npx tsx --test tests/group-ops.test.ts tests/chat-flow.test.ts`
Expected: PASS. Then add one assertion to an existing chat-delete test, or a new small case in `tests/group-ops.test.ts`, confirming that `pruneSessionOp` is what `deleteChatSession` calls (inspect with `grep -n pruneSessionOp src/server/chats.ts`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(groups): group operations with counts, HTTP API, prune on chat delete"
```

---

### Task 5: Folder import (relative paths, group tree, bare-name reuse)

**Files:**
- Create: `src/core/folder-groups.ts`
- Modify: `src/agent/subagents/extraction.ts` (line 1421), `app/api/graph/import/route.ts`, `components/notes-import.tsx`
- Test: `tests/folder-groups.test.ts`; extend `tests/notes-import-route.test.ts`, `tests/notes-import.test.tsx`

**Interfaces:**
- Consumes: `createGroup`, `addSessionsToGroup`, `GROUP_NAME_MAX` (Task 1); `GraphStore.readGroups/writeGroups`.
- Produces:
  - `normalizeImportPath(raw: string): string`
  - `planFolderGroups(state, paths, mintId): { state; fileGroup: Map<string, string>; created: number; reused: number }`
  - `matchBareNameSources(sources, paths): Map<string, string>` (path to existing source id)
  - `applyFolderGroups(graphStore, paths, sourceIdOf, reuse): { created: number; reused: number }`
  - `notesSourceId(filePath: string): string` exported from `src/agent/subagents/extraction.ts`
  - Client: `postNotesImport(files, paths?)`, `parseNotesImportResults(body, files, paths?)`, `useNotesImport().onImportEntries(entries)`

- [ ] **Step 1: Write the failing tests**

Create `tests/folder-groups.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyGroups } from "../src/core/groups.ts";
import { matchBareNameSources, normalizeImportPath, planFolderGroups } from "../src/core/folder-groups.ts";

let n = 0;
const mint = () => `g${++n}`;

describe("normalizeImportPath", () => {
	it("uses forward slashes and strips leading separators", () => {
		assert.equal(normalizeImportPath("FINA 411\\Risk\\Ch 05.md"), "FINA 411/Risk/Ch 05.md");
		assert.equal(normalizeImportPath("/a//b.md"), "a/b.md");
		assert.equal(normalizeImportPath("./a.md"), "a.md");
	});
});

describe("planFolderGroups", () => {
	it("mirrors the folder tree and maps each file to its folder's group", () => {
		n = 0;
		const plan = planFolderGroups(emptyGroups(), ["Vault/A/x.md", "Vault/A/y.md", "Vault/B/z.md", "Vault/top.md"], mint);
		assert.deepEqual(plan.state.groups, [
			{ id: "g1", name: "Vault" },
			{ id: "g2", name: "A", parentGroupId: "g1" },
			{ id: "g3", name: "B", parentGroupId: "g1" },
		]);
		assert.equal(plan.fileGroup.get("Vault/A/x.md"), "g2");
		assert.equal(plan.fileGroup.get("Vault/A/y.md"), "g2");
		assert.equal(plan.fileGroup.get("Vault/B/z.md"), "g3");
		assert.equal(plan.fileGroup.get("Vault/top.md"), "g1");
		assert.equal(plan.created, 3);
		assert.equal(plan.reused, 0);
	});
	it("reuses groups with the same name under the same parent", () => {
		n = 0;
		const first = planFolderGroups(emptyGroups(), ["Vault/A/x.md"], mint);
		const second = planFolderGroups(first.state, ["Vault/A/y.md", "Vault/C/z.md"], mint);
		assert.equal(second.created, 1);
		assert.equal(second.reused, 2);
		assert.equal(second.fileGroup.get("Vault/A/y.md"), "g2");
	});
	it("leaves files with no folder ungrouped", () => {
		const plan = planFolderGroups(emptyGroups(), ["solo.md"], mint);
		assert.equal(plan.fileGroup.size, 0);
		assert.deepEqual(plan.state.groups, []);
	});
	it("clamps over-long folder names to the group-name limit", () => {
		n = 0;
		const plan = planFolderGroups(emptyGroups(), [`${"x".repeat(120)}/a.md`], mint);
		assert.equal(plan.state.groups[0]!.name.length, 80);
	});
});

describe("matchBareNameSources", () => {
	const src = (id: string, filePath: string) => ({ id, filePath });
	it("matches a dropped file to the single existing bare-name source", () => {
		const m = matchBareNameSources([src("src_1", "Ch 01.md")], ["FINA/Ch 01.md", "FINA/Ch 02.md"]);
		assert.deepEqual([...m], [["FINA/Ch 01.md", "src_1"]]);
	});
	it("does not match when the bare name is ambiguous on either side", () => {
		assert.equal(matchBareNameSources([src("a", "x.md"), src("b", "x.md")], ["F/x.md"]).size, 0);
		assert.equal(matchBareNameSources([src("a", "x.md")], ["F/x.md", "G/x.md"]).size, 0);
	});
	it("never matches bare drops or exact relative re-drops", () => {
		assert.equal(matchBareNameSources([src("a", "x.md")], ["x.md"]).size, 0);
		assert.equal(matchBareNameSources([src("a", "F/x.md"), src("b", "x.md")], ["F/x.md"]).size, 0);
	});
});
```

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/folder-groups.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/core/folder-groups.ts`**

```ts
/**
 * FOLDER IMPORT → GROUPS (2026-10-27): a dropped vault folder becomes a
 * group tree mirroring its directories, with each file's session placed in
 * its folder's group. Pure planning over GroupsState; the route owns I/O.
 * Browser-safe (no node builtins).
 */
import type { GroupsState, NotesSource } from "./contracts/graph.ts";
import type { GraphStore } from "./ports.ts";
import { addSessionsToGroup, createGroup, GROUP_NAME_MAX } from "./groups.ts";

/** Forward slashes, no leading "./" or "/", no empty segments. */
export function normalizeImportPath(raw: string): string {
	return raw
		.replace(/\\/g, "/")
		.split("/")
		.filter((seg) => seg !== "" && seg !== ".")
		.join("/");
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export interface FolderPlan {
	state: GroupsState;
	/** file path → the group of its folder (files with no folder are absent). */
	fileGroup: Map<string, string>;
	created: number;
	reused: number;
}

/** Walk each file's directories, reusing a group with the same name under
 *  the same parent, creating the rest. */
export function planFolderGroups(state: GroupsState, paths: readonly string[], mintId: () => string): FolderPlan {
	let current = state;
	const fileGroup = new Map<string, string>();
	let created = 0;
	let reused = 0;
	for (const path of paths) {
		const dirs = path.split("/").slice(0, -1);
		let parent: string | undefined;
		for (const raw of dirs) {
			const name = raw.trim().replace(/\s+/g, " ").slice(0, GROUP_NAME_MAX);
			if (name === "") continue;
			const existing = current.groups.find((g) => g.name === name && g.parentGroupId === parent);
			if (existing) {
				if (!fileGroup.has(`#seen:${existing.id}`)) reused++;
				fileGroup.set(`#seen:${existing.id}`, existing.id);
				parent = existing.id;
			} else {
				const id = mintId();
				current = createGroup(current, { id, name, parentGroupId: parent });
				fileGroup.set(`#seen:${id}`, id);
				created++;
				parent = id;
			}
		}
		if (parent !== undefined) fileGroup.set(path, parent);
	}
	for (const key of [...fileGroup.keys()]) if (key.startsWith("#seen:")) fileGroup.delete(key);
	return { state: current, fileGroup, created, reused };
}

/** Dropped `Folder/Ch 01.md` ↔ an earlier bare-name import `Ch 01.md`:
 *  reuse that source (place it, do not re-extract) when the bare name is
 *  unique among existing bare-name sources AND among this drop. */
export function matchBareNameSources(
	sources: readonly Pick<NotesSource, "id" | "filePath">[],
	paths: readonly string[],
): Map<string, string> {
	const bare = new Map<string, string[]>();
	for (const s of sources) {
		if (s.filePath.includes("/")) continue;
		bare.set(s.filePath, [...(bare.get(s.filePath) ?? []), s.id]);
	}
	const dropped = new Map<string, number>();
	for (const p of paths) dropped.set(baseName(p), (dropped.get(baseName(p)) ?? 0) + 1);
	const out = new Map<string, string>();
	for (const p of paths) {
		if (!p.includes("/")) continue;
		if (sources.some((s) => s.filePath === p)) continue; // exact re-drop re-extracts as today
		const candidates = bare.get(baseName(p)) ?? [];
		if (candidates.length !== 1 || dropped.get(baseName(p)) !== 1) continue;
		out.set(p, candidates[0]!);
	}
	return out;
}

/** Create the folder groups and place every file's session (the reused
 *  source id when matched, else the path-hash source id). One write. */
export function applyFolderGroups(
	graphStore: Pick<GraphStore, "readGroups" | "writeGroups">,
	paths: readonly string[],
	sourceIdOf: (path: string) => string,
	reuse: ReadonlyMap<string, string>,
): { created: number; reused: number } {
	const plan = planFolderGroups(graphStore.readGroups(), paths, () => `grp_${globalThis.crypto.randomUUID().slice(0, 8)}`);
	let state = plan.state;
	for (const [path, groupId] of plan.fileGroup) {
		state = addSessionsToGroup(state, groupId, [reuse.get(path) ?? sourceIdOf(path)]).state;
	}
	graphStore.writeGroups(state);
	return { created: plan.created, reused: plan.reused };
}
```

Note: the `#seen:` bookkeeping keeps the reused count per distinct group. If you prefer, replace it with a local `Set<string>` of visited group ids; behavior is identical (the test pins `reused`).

- [ ] **Step 4: Run and verify pass**

Run: `NODE_ENV=test npx tsx --test tests/folder-groups.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the source-id helper**

In `src/agent/subagents/extraction.ts`, add at module scope (near the other exported helpers, before `createExtractionPipeline`):

```ts
/** The deterministic notes source id for a file path (src_ + 12 hex of the
 *  path's sha256): the birth-session key of everything that file mints. */
export function notesSourceId(filePath: string): string {
	return `src_${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}
```

and replace the inline line in `importNotes` (line 1421) with `const id = notesSourceId(input.filePath);`.

- [ ] **Step 6: Route accepts relative paths**

In `app/api/graph/import/route.ts`: add imports

```ts
import { applyFolderGroups, matchBareNameSources, normalizeImportPath } from "@/src/core/folder-groups.ts";
import { notesSourceId } from "@/src/agent/subagents/extraction.ts";
import { stores } from "@/src/server/stores.ts";
```

Replace the start of `POST` (from `const form =` through the `queue`/`workers` setup head) with:

```ts
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
			results.push({ requestIndex, filePath: path, outcome: "completed", ok: true, stats: { nodes: 0, chains: 0 }, reusedSourceId: sourceId } as ImportResult);
		}
	}
	const queue = files
		.map((file, requestIndex) => ({ file, requestIndex, filePath: paths[requestIndex]! }))
		.filter((entry) => !reuse.has(entry.filePath));
	const workers = Array.from({ length: Math.min(3, Math.max(queue.length, 1)) }, async () => {
```

Inside the worker loop replace every `file.name` with `filePath` (destructure `const { file, requestIndex, filePath } = next;` and use `filePath` in `extraction.importNotes({ filePath, text })` and in every `results.push({ filePath, ... })`). Add `reusedSourceId?: string;` to `ImportResult`.

- [ ] **Step 7: Client transport**

In `components/notes-import.tsx`:

- `parseNotesImportResults(body, files, paths?)`: replace the `r.filePath !== files[r.requestIndex]!.name` comparison with `r.filePath !== (paths?.[r.requestIndex] ?? files[r.requestIndex]!.name)`.
- `postNotesImport(files, paths?)`: after appending each file, `if (paths) for (const p of paths) form.append("paths", p);` and pass `paths` into `parseNotesImportResults(body, files, paths)`.
- `useNotesImport`: change `submit` to `(files: File[], paths?: string[])`, pass `paths` to `postNotesImport`, and in the catch use `paths?.[i] ?? file.name`. Add to the returned object:

```ts
		onImportEntries: (entries: { file: File; path: string }[]) => {
			if (entries.length > 0) void submit(entries.map((e) => e.file), entries.map((e) => e.path));
		},
```

- [ ] **Step 8: Extend route and client tests**

In `tests/notes-import-route.test.ts` add a case that posts a form with `files` and a parallel `paths` field and asserts `extraction.importNotes` receives the relative paths and each result's `filePath` equals the relative path; and a case with mismatched `paths` length returning 400. Follow that file's existing `request(...)` helper style (add a `requestWithPaths(files: [name, path][])` helper).

In `tests/notes-import.test.tsx` add a `parseNotesImportResults` case where `paths` are supplied and results echo the relative paths (valid) and a case where a result's filePath is the bare file name instead (throws "Invalid import response").

- [ ] **Step 9: Run**

Run: `NODE_ENV=test npx tsx --test tests/folder-groups.test.ts tests/notes-import-route.test.ts tests/notes-import.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(groups): folder import builds a group tree and reuses bare-name sources"
```

---

### Task 6: Agent tools — teacher group tools

**Files:**
- Create: `src/agent/tools/groups.ts`
- Modify: `src/agent/tools.ts` (`TeacherToolContext` line 393, `createTeacherTools` line 434), `src/server/chat-handler.ts` (teacher agent construction, line ~451)
- Test: `tests/group-tools.test.ts`

**Interfaces:**
- Consumes: `group-ops` (Task 4), `GroupError`, `serverExecute` (`src/agent/tool-execute.ts`), `GraphToolContext` (`src/agent/tools/graph.ts`).
- Produces: `groupTools(ctx: GraphToolContext): Record<string, AgentTool<any>>` with `create_group`, `add_sessions_to_group`, `remove_sessions_from_group`, `rename_group`, `delete_group`, `list_groups`; `TeacherToolContext.graph?: GraphToolContext`.

- [ ] **Step 1: Write the failing tests**

Create `tests/group-tools.test.ts`. Build fakes like `tests/group-ops.test.ts` (stateful `readGroups/writeGroups`, `readSources`, `readNodes`). Call a tool with `await tool.execute("call1", input, undefined)` (see how `tests/graph-tools.test.ts` invokes `list_sessions` and reads the text from the result's `content[0].text`; mirror its helper `textOf`). Cases:

```ts
it("create_group returns the id and counts", async () => {
	const out = await run("create_group", { name: "Risk & Return", sessionIds: ["src_a"] });
	assert.match(out, /Created group 'Risk & Return' \(grp_[0-9a-f]{8}\)\. Moved 1 session \(3 nodes\) into it\. 0 chains affected\./);
});
it("add/remove/rename/list round trip", async () => { /* create A, add src_b, assert 'Moved 1 session (2 nodes) into 'A'', rename, list_groups line `grp_… | A | 1 session | 2 nodes`, remove */ });
it("unknown ids answer in the tool's own voice, never throw", async () => {
	assert.match(await run("add_sessions_to_group", { groupId: "ghost", sessionIds: ["src_a"] }), /No group "ghost"/);
	assert.match(await run("create_group", { name: "X", sessionIds: ["nope"] }), /Unknown session id/);
});
it("delete_group previews first and deletes only with the issued token", async () => {
	const id = /\(grp_[0-9a-f]{8}\)/.exec(await run("create_group", { name: "Gone" }))![0].slice(1, -1);
	const preview = await run("delete_group", { groupId: id });
	assert.match(preview, /Nothing has been deleted yet/);
	assert.equal(state.groups.length, 1);
	const token = /confirmToken "([0-9a-f]{8})"/.exec(preview)![1]!;
	assert.match(await run("delete_group", { groupId: id, confirmToken: "deadbeef" }), /invalid or expired/);
	assert.equal(state.groups.length, 1);
	assert.match(await run("delete_group", { groupId: id, confirmToken: token }), /Deleted group 'Gone'/);
	assert.equal(state.groups.length, 0);
	assert.match(await run("delete_group", { groupId: id, confirmToken: token }), /invalid or expired/); // one-time
});
it("a token is bound to its group", async () => { /* preview group A, try to use A's token on group B → invalid */ });
it("the teacher registry carries the tools only when a graph context is passed", () => {
	const without = createTeacherTools({ chatId: "c", chatStore, jobStore, spawn: () => {} } as never);
	assert.equal("create_group" in without, false);
	const withGraph = createTeacherTools({ chatId: "c", chatStore, jobStore, spawn: () => {}, graph: { chatStore, graphStore } } as never);
	for (const name of ["create_group", "add_sessions_to_group", "remove_sessions_from_group", "rename_group", "delete_group", "list_groups"]) assert.ok(name in withGraph, name);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/group-tools.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/agent/tools/groups.ts`**

```ts
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import * as ops from "../../core/group-ops.ts";
import { GroupError } from "../../core/groups.ts";
import type { GraphToolContext } from "./graph.ts";

/**
 * THE TEACHER'S GROUP TOOLS (2026-10-27): the learner can say "group my
 * FINA 411 chapters" and the teacher organizes the knowledge map. A group
 * holds SESSIONS (ids from list_sessions); moving sessions never touches a
 * node or chain. Registered on the teacher only, behind the SAME
 * graphToolsEnabled gate as the prober's map readers.
 *
 * delete_group is a code-enforced two-step: the first call (no token)
 * writes nothing and returns a preview + one-time token; only a second
 * call carrying that token deletes. The agent can only get a token by
 * previewing, which is the prompt to ask the learner.
 */

const CONFIRM_TTL_MS = 10 * 60 * 1000;
/** Module-level on purpose: the preview and the confirming call land in
 *  different turns, so different tool-registry instances. */
const pendingDeletes = new Map<string, { groupId: string; expires: number }>();

/** Tool answers speak in their own voice: a GroupError is an answer, never a throw. */
async function answer(run: () => string): Promise<string> {
	try {
		return run();
	} catch (err) {
		if (err instanceof GroupError) return err.message;
		throw err;
	}
}

const sessionIds = Type.Array(Type.String({ minLength: 1 }), {
	minItems: 1,
	description: "Session ids exactly as list_sessions reports them (chat ids or src_… notes ids).",
});

export function groupTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };

	const createInput = Type.Object({
		name: Type.String({ minLength: 1, description: "The group's name, e.g. 'FINA 411'." }),
		parentGroupId: Type.Optional(Type.String({ description: "Nest the new group under this group id." })),
		sessionIds: Type.Optional(sessionIds),
	});
	const addInput = Type.Object({ groupId: Type.String({ minLength: 1 }), sessionIds });
	const removeInput = Type.Object({ sessionIds });
	const renameInput = Type.Object({ groupId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) });
	const deleteInput = Type.Object({
		groupId: Type.String({ minLength: 1 }),
		confirmToken: Type.Optional(
			Type.String({ description: "The token a previous delete_group call returned, ONLY after the learner confirmed." }),
		),
	});
	const listInput = Type.Object({});

	return {
		create_group: {
			name: "create_group",
			label: "create_group",
			description:
				"Create a named group on the learner's knowledge map, optionally nested under another group and optionally filled with sessions. " +
				"A group holds whole sessions (chats / imported notes files) — e.g. all the chapters of one course. Returns the new group's id and counts.",
			parameters: createInput,
			execute: serverExecute("create_group", createInput, async (input): Promise<string> =>
				answer(() => ops.createGroupOp(deps, input).message)),
		},
		add_sessions_to_group: {
			name: "add_sessions_to_group",
			label: "add_sessions_to_group",
			description:
				"Move sessions into a group, including sessions already in another group (they leave it). Chains and nodes are never changed. Returns counts.",
			parameters: addInput,
			execute: serverExecute("add_sessions_to_group", addInput, async ({ groupId, sessionIds }): Promise<string> =>
				answer(() => ops.addSessionsOp(deps, groupId, sessionIds).message)),
		},
		remove_sessions_from_group: {
			name: "remove_sessions_from_group",
			label: "remove_sessions_from_group",
			description: "Take sessions out of whatever group they are in (they become ungrouped). Chains and nodes are never changed.",
			parameters: removeInput,
			execute: serverExecute("remove_sessions_from_group", removeInput, async ({ sessionIds }): Promise<string> =>
				answer(() => ops.removeSessionsOp(deps, sessionIds).message)),
		},
		rename_group: {
			name: "rename_group",
			label: "rename_group",
			description: "Rename a group.",
			parameters: renameInput,
			execute: serverExecute("rename_group", renameInput, async ({ groupId, name }): Promise<string> =>
				answer(() => ops.renameGroupOp(deps, groupId, name).message)),
		},
		delete_group: {
			name: "delete_group",
			label: "delete_group",
			description:
				"Delete a group — a TWO-STEP action. Call it first WITHOUT confirmToken: nothing is deleted, you get a preview and a one-time token. " +
				"Tell the learner what will happen and ask them to confirm; only if they say yes, call again with the same groupId and that confirmToken. " +
				"Deleting never touches nodes or chains; subgroups and held sessions move up to the group's parent (or become ungrouped).",
			parameters: deleteInput,
			execute: serverExecute("delete_group", deleteInput, async ({ groupId, confirmToken }): Promise<string> =>
				answer(() => {
					if (confirmToken === undefined) {
						const preview = ops.previewDeleteGroupOp(deps, groupId);
						const token = globalThis.crypto.randomUUID().slice(0, 8);
						pendingDeletes.set(token, { groupId, expires: Date.now() + CONFIRM_TTL_MS });
						return (
							`${preview.message} Nothing has been deleted yet. Ask the learner to confirm; if they say yes, ` +
							`call delete_group again with groupId "${groupId}" and confirmToken "${token}".`
						);
					}
					const pending = pendingDeletes.get(confirmToken);
					if (!pending || pending.groupId !== groupId || pending.expires < Date.now()) {
						return "That confirmation is invalid or expired — call delete_group without a token to get a fresh preview.";
					}
					pendingDeletes.delete(confirmToken);
					return ops.deleteGroupOp(deps, groupId).message;
				})),
		},
		list_groups: {
			name: "list_groups",
			label: "list_groups",
			description:
				"List the knowledge map's groups. Each line: id | name (with its parent path) | session count | node count (subgroups included).",
			parameters: listInput,
			execute: serverExecute("list_groups", listInput, async (): Promise<string> => {
				const groups = ops.listGroupsOp(deps);
				if (groups.length === 0) return "There are no groups yet.";
				return groups
					.map((g) => `${g.id} | ${g.path} | ${g.sessions} session${g.sessions === 1 ? "" : "s"} | ${g.nodes} node${g.nodes === 1 ? "" : "s"}`)
					.join("\n");
			}),
		},
	};
}
```

If `serverExecute`'s generic typing rejects the optional-object destructuring in `create_group`, annotate the handler parameter with `Static<typeof createInput>` (import `type Static` from `typebox`), as other tools in `src/agent/tools/*.ts` do.

- [ ] **Step 4: Register on the teacher**

In `src/agent/tools.ts`: add `import { groupTools } from "./tools/groups.ts";` and `import type { GraphToolContext } from "./tools/graph.ts";` (extend the existing `proberGraphTools` import line instead of adding a second one). Add to `TeacherToolContext`:

```ts
	/** The group tools (2026-10-27): present only when the composition root
	 *  opened the graph-tools gate (same gate as the prober's map readers).
	 *  Absent = no group tools (tests drive this seam). */
	graph?: GraphToolContext;
```

In `createTeacherTools`, after `...planTools(ctx),` add `...(ctx.graph ? groupTools(ctx.graph) : {}),`.

In `src/server/chat-handler.ts`, in the `createTeacherAgent({ ... })` call (the `teaching ?` branch), add after `searchAvailable,`:

```ts
						// The group tools (2026-10-27): behind the SAME gate as the
						// prober's map readers.
						...(graphToolsEnabled(effective) ? { graph: { chatStore: stores.chatStore, graphStore: stores.graphStore } } : {}),
```

- [ ] **Step 5: Add the teacher guidance line**

Append to the teacher prompt where it describes its tools (`src/agent/prompts/teacher/` — open `20-teaching.md` or the file that lists tool usage; `grep -rn "list_sessions" src/agent/prompts` shows where the prober's map tools are described and mirrors that style). Add 2 sentences: the group tools exist, groups hold whole sessions, and delete_group needs the learner's confirmation. If no teacher prompt segment covers tools, skip this step; the tool descriptions suffice.

- [ ] **Step 6: Run**

Run: `NODE_ENV=test npx tsx --test tests/group-tools.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(groups): teacher group tools with two-step delete"
```

---

### Task 7: Read tools gain group filter and group label

**Files:**
- Modify: `src/agent/tools/graph.ts` (`list_sessions`, `list_propositions` in `proberGraphTools` and `auditorGraphTools`)
- Test: extend `tests/graph-tools.test.ts`

**Interfaces:**
- Consumes: `graphSessionIndex(deps, { groupId })` and `GraphSessionEntry.groupName` (Task 3), `sessionIdsInGroup` (Task 1).

- [ ] **Step 1: Write failing tests**

In `tests/graph-tools.test.ts` extend `fakeStores` with an optional `groups` override defaulting to empty (`readGroups: () => over.groups ?? { groups: [], sessionGroups: {} }`) and add cases:

```ts
it("prober list_sessions shows each session's group and filters by groupId", async () => {
	// two sessions src_a (in group g1 "FINA 411") and src_b (ungrouped)
	const all = await runProber("list_sessions", {});
	assert.match(all, /src_a/); assert.match(all, /group: FINA 411/);
	assert.doesNotMatch(lineFor(all, "src_b"), /group:/);
	const filtered = await runProber("list_sessions", { groupId: "g1" });
	assert.match(filtered, /src_a/); assert.doesNotMatch(filtered, /src_b/);
});
it("list_propositions takes a groupId and lists every session in it, names only", async () => { /* expects a header per session and node NAMES, never statements */ });
it("list_propositions needs exactly one of session / groupId", async () => {
	assert.match(await runProber("list_propositions", {}), /exactly one of/);
	assert.match(await runProber("list_propositions", { session: "x", groupId: "g1" }), /exactly one of/);
});
it("existing ungrouped output is unchanged", /* the pre-existing assertions still pass untouched */);
```

Use the file's existing helpers to build the prober/auditor registries and read tool text; keep the "statement must never leak" fixture and assert statements are absent from the group listing.

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/graph-tools.test.ts`
Expected: new cases FAIL.

- [ ] **Step 3: Implement**

In `src/agent/tools/graph.ts`:

1. Add `import { sessionIdsInGroup } from "../../core/groups.ts";`.
2. Replace `listSessionsInput` with:

```ts
const listSessionsInput = Type.Object({
	groupId: Type.Optional(Type.String({ description: "Only sessions in this group (subgroups included). Ids come from the group's owner; omit for all sessions." })),
});
```

3. Replace `listPropositionsInput` with:

```ts
const listPropositionsInput = Type.Object({
	session: Type.Optional(Type.String({
		minLength: 1,
		description: "The session's id exactly as list_sessions reported it (a chat id or a notes source id). Give this OR groupId.",
	})),
	groupId: Type.Optional(Type.String({ description: "A group id: lists the propositions born in every session in the group (subgroups included). Give this OR session." })),
});
```

4. Add a shared helper above `proberGraphTools`:

```ts
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
```

5. In the prober's `list_sessions`: change the handler to `async ({ groupId }) => { const sessions = graphSessionIndex(deps, { groupId }); ... }` and append the group to each line: after the `— id: ${s.id}` piece add `${s.groupName ? ` — group: ${s.groupName}` : ""}` (before the id so the id stays last: `... last active X) — group: FINA 411 — id: src_a`). When `groupId` is given and nothing matches return `No sessions in group "${groupId}".`.
6. Same change to the auditor's `list_sessions` line format.
7. In both `list_propositions` handlers: call `sessionsFor`; on `error` return it; for a single session keep today's exact output (including the `No propositions born in session "..."` text); for a group, loop sessions and emit `Session ${name} (id: ${id}):` followed by the existing per-proposition lines (prober: `- ${p.name}`; auditor: the id/statement lines), joined by blank lines, with a total header `${n} proposition(s) across ${m} session(s) in this group:`. Session names for headers come from `graphSessionIndex(deps)` (`name` field). A group with no sessions returns `No sessions in group "${groupId}".`.

Update both tool descriptions with one sentence each about the group filter and group label.

- [ ] **Step 4: Run**

Run: `NODE_ENV=test npx tsx --test tests/graph-tools.test.ts tests/session-clusters.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(groups): read tools show group and filter by group"
```

---

### Task 8: Collapse projection (pure)

**Files:**
- Create: `components/group-projection.ts`
- Test: `tests/group-projection.test.ts`

**Interfaces:**
- Consumes: `GraphGroup`, `GraphNode` types; `birthSessionOf`, `impClusterKey` from `src/core/session-clusters.ts`.
- Produces:

```ts
export const GROUP_NODE_PREFIX = "group:";
export const isGroupNodeId: (id: string) => boolean;
export interface ProjectionInput { nodes; propositions; edges; logicalEdges; impLinks; clusters; groups; sessionGroups; collapsed: ReadonlySet<string> }
export interface ProjectedGroupBox { id: string; label: string; level: number; members: string[] }
export interface Projection {
	nodes: { id: string; x: number; y: number; label: string }[];
	edges: { from: string; to: string }[];
	logicalEdges: { from: string; to: string }[];
	impLinks: { id: string; premises: string[]; conclusion: string }[];
	clusters: { id: string; label: string | null; members: string[] }[];
	groupBoxes: ProjectedGroupBox[];
	blobIds: string[];
}
export function projectGroups(input: ProjectionInput, pos: (id: string) => { x: number; y: number }): Projection;
```

- [ ] **Step 1: Write the failing tests**

Create `tests/group-projection.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GROUP_NODE_PREFIX, projectGroups, type ProjectionInput } from "../components/group-projection.ts";

const prop = (id: string, session: string) => ({ id, provenance: [{ chatId: session, messageId: "m" }] });
const base = (): ProjectionInput => ({
	nodes: [
		{ id: "a1", name: "A1" }, { id: "a2", name: "A2" },
		{ id: "b1", name: "B1" }, { id: "c1", name: "C1" },
		{ id: "arg_1", name: "" },
	],
	propositions: [prop("a1", "s_a"), prop("a2", "s_a"), prop("b1", "s_b"), prop("c1", "s_c")],
	edges: [
		{ from: "a1", to: "a2" }, // internal to s_a
		{ from: "a1", to: "b1" }, { from: "a2", to: "b1" }, // two edges a→b: bundle to one
		{ from: "b1", to: "c1" },
		{ from: "a1", to: "arg_1" }, { from: "b1", to: "arg_1" }, { from: "arg_1", to: "c1" },
	],
	logicalEdges: [{ from: "a1", to: "a2" }, { from: "a1", to: "c1" }, { from: "b1", to: "c1" }],
	impLinks: [{ id: "arg_1", premises: ["a1", "b1"], conclusion: "c1" }],
	clusters: [
		{ id: "s_a", label: "A", members: ["a1", "a2"] }, { id: "s_b", label: "B", members: ["b1"] }, { id: "s_c", label: "C", members: ["c1"] },
	],
	groups: [{ id: "g1", name: "FINA" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
	sessionGroups: { s_a: "g2", s_b: "g1" },
	collapsed: new Set(),
});
const at = () => ({ x: 0, y: 0 });

describe("projectGroups", () => {
	it("with nothing collapsed leaves the graph as is and boxes each group", () => {
		const p = projectGroups(base(), (id) => ({ x: id === "a1" ? 10 : 0, y: 0 }));
		assert.equal(p.nodes.length, 5);
		assert.equal(p.edges.length, 7);
		assert.deepEqual(p.blobIds, []);
		const fina = p.groupBoxes.find((b) => b.id === "g1")!;
		const risk = p.groupBoxes.find((b) => b.id === "g2")!;
		assert.deepEqual([...risk.members].sort(), ["a1", "a2", "arg_1"].filter((m) => m !== "arg_1").concat([]).sort().concat(risk.members.includes("arg_1") ? ["arg_1"] : []).sort());
		assert.equal(risk.level, 0);
		assert.equal(fina.level, 1);
		assert.ok(fina.members.includes("b1") && fina.members.includes("a1"));
	});

	it("collapsing a group replaces its nodes with one blob, drops internal edges and bundles the rest", () => {
		const input = { ...base(), collapsed: new Set(["g2"]) };
		const p = projectGroups(input, (id) => ({ x: id === "a1" ? 0 : id === "a2" ? 10 : 0, y: 0 }));
		const blob = `${GROUP_NODE_PREFIX}g2`;
		assert.deepEqual(p.blobIds, [blob]);
		assert.equal(p.nodes.some((n) => n.id === "a1" || n.id === "a2"), false);
		const b = p.nodes.find((n) => n.id === blob)!;
		assert.equal(b.label, "Risk · 2");
		assert.equal(b.x, 5); // centroid of a1 (0) and a2 (10)
		// a1→a2 internal edge gone; a1→b1 and a2→b1 bundled into one blob→b1
		assert.equal(p.edges.filter((e) => e.from === blob && e.to === "b1").length, 1);
		assert.equal(p.edges.some((e) => e.from === "a1" || e.to === "a2"), false);
		assert.deepEqual(p.logicalEdges.filter((e) => e.from === blob), [{ from: blob, to: "c1" }]);
		// the blob gets its own region so its name shows when zoomed out
		assert.ok(p.clusters.some((c) => c.id === blob && c.label === "Risk" && c.members.join() === blob));
		assert.equal(p.clusters.some((c) => c.id === "s_a"), false);
		// a collapsed group has no box of its own
		assert.equal(p.groupBoxes.some((x) => x.id === "g2"), false);
	});

	it("the outermost collapsed ancestor wins", () => {
		const p = projectGroups({ ...base(), collapsed: new Set(["g1", "g2"]) }, at);
		assert.deepEqual(p.blobIds, [`${GROUP_NODE_PREFIX}g1`]);
		assert.equal(p.nodes.some((n) => n.id === "a1" || n.id === "b1"), false);
		assert.equal(p.nodes.find((n) => n.id === `${GROUP_NODE_PREFIX}g1`)!.label, "FINA · 3");
		assert.equal(p.groupBoxes.length, 0);
	});

	it("an imp node follows the majority of its premises' sessions", () => {
		const p = projectGroups({ ...base(), collapsed: new Set(["g2"]) }, at);
		// arg_1 premises: a1 (g2) and b1 (g1) → tie → alphabetically-first session s_a → inside the g2 blob
		assert.equal(p.nodes.some((n) => n.id === "arg_1"), false);
		assert.equal(p.impLinks.length, 0);
	});

	it("ungrouped sessions are untouched and no groups means identity", () => {
		const input = { ...base(), groups: [], sessionGroups: {} };
		const p = projectGroups(input, at);
		assert.equal(p.nodes.length, 5);
		assert.deepEqual(p.groupBoxes, []);
		assert.deepEqual(p.clusters.map((c) => c.id), ["s_a", "s_b", "s_c"]);
	});
});
```

Simplify the first test's `risk.members` assertion when you write it: assert `risk.members.sort()` deep-equals `["a1", "a2"]` plus `"arg_1"` only if the tie-break puts `arg_1` in `s_a` (it does, so expect `["a1", "a2", "arg_1"]`). Fix the test to that exact expectation rather than the convoluted line above.

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/group-projection.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `components/group-projection.ts`**

```ts
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
import type { GraphGroup, GraphNode } from "../src/core/contracts.ts";
import { birthSessionOf, impClusterKey } from "../src/core/session-clusters.ts";

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
		const ps = members.map(pos);
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
	const levelOf = (groupId: string): number => {
		const kids = input.groups.filter((g) => g.parentGroupId === groupId && boxMembers.has(g.id) && !input.collapsed.has(g.id));
		return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => levelOf(k.id)));
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
```

- [ ] **Step 4: Run and verify pass**

Run: `NODE_ENV=test npx tsx --test tests/group-projection.test.ts`
Expected: PASS. If the box-members assertions fail because `levelOf` double counts, trace with the failing test's numbers; the contract is: `g2.level === 0`, `g1.level === 1`.

- [ ] **Step 5: Commit**

```bash
git add components/group-projection.ts tests/group-projection.test.ts
git commit -m "feat(groups): pure collapse projection"
```

---

### Task 9: Canvas group boxes and graph-view feed

**Files:**
- Modify: `components/graph-canvas.ts` (types near line 106-137; `draw()` near line 1643; new method before `draw`), `components/graph-view.tsx` (imports line 66-79; state near line 981; `onSelect` line 1348; Feed #1 line 1414; Feed #3 line 1449)
- Test: extend `tests/graph-canvas.test.ts` (pure `boxBounds`)

**Interfaces:**
- Consumes: `projectGroups`, `isGroupNodeId`, `GROUP_NODE_PREFIX` (Task 8); `snapshot.groups/sessionGroups` (Task 3).
- Produces: `CanvasData.groupBoxes?: CanvasGroupBox[]`; exported pure `boxBounds(points, pad)`; `GraphView` state `collapsedGroups` and `toggleGroup(id)` (consumed by Task 10).

- [ ] **Step 1: Write the failing test for `boxBounds`**

Add to `tests/graph-canvas.test.ts`:

```ts
import { boxBounds } from "../components/graph-canvas.ts";

describe("boxBounds (the group box's pure geometry)", () => {
	test("pads the points' bounding box on every side", () => {
		assert.deepEqual(boxBounds([{ x: 0, y: 0 }, { x: 10, y: 4 }], 2), { x: -2, y: -2, w: 14, h: 8 });
	});
	test("a single point still gets a box", () => {
		assert.deepEqual(boxBounds([{ x: 5, y: 5 }], 3), { x: 2, y: 2, w: 6, h: 6 });
	});
	test("no points, no box", () => {
		assert.equal(boxBounds([], 3), null);
	});
});
```

(Place the import with the file's other `graph-canvas.ts` imports.)

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/graph-canvas.test.ts`
Expected: FAIL (`boxBounds` is not exported).

- [ ] **Step 3: Canvas types, `boxBounds`, draw pass**

In `components/graph-canvas.ts`:

After `CanvasCluster` add:

```ts
/** One EXPANDED group's box: a dashed rounded rectangle around its visible
 *  members with the group's name above its top-left corner (2026-10-27
 *  grouping). `level` is the nesting depth BELOW the group — outer boxes
 *  pad wider so nested boxes never touch their parent's outline. */
export interface CanvasGroupBox {
	id: string;
	label: string;
	level: number;
	members: string[];
}

/** The padded bounding box of a point set, or null when empty. */
export function boxBounds(
	points: ReadonlyArray<{ x: number; y: number }>,
	pad: number,
): { x: number; y: number; w: number; h: number } | null {
	if (points.length === 0) return null;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}
```

In `CanvasData` add `groupBoxes?: CanvasGroupBox[];` after `clusters`.

Add this method on the renderer class directly above `private draw()`:

```ts
	/** Expanded-group boxes: dashed rounded outline + name, drawn under the
	 *  edges (after the region bitmap). Bounds are read from the live node
	 *  positions each frame so boxes follow the sim exactly like the nodes;
	 *  hidden (search-filtered) members don't stretch a box. Hairline stroke
	 *  and screen-fixed label size (÷ k), like every other viewer-relative UI. */
	private drawGroupBoxes(ctx: CanvasRenderingContext2D, k: number): void {
		const boxes = this.data?.groupBoxes;
		const settings = this.settings;
		if (!boxes || boxes.length === 0 || !settings || !this.data) return;
		const { nodeR } = this.world;
		ctx.save();
		ctx.lineWidth = 1 / k;
		ctx.setLineDash([6 / k, 4 / k]);
		ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize / k}px ${this.data.fontFamily}`;
		ctx.textAlign = "left";
		ctx.textBaseline = "bottom";
		for (const box of boxes) {
			const points: { x: number; y: number }[] = [];
			for (const id of box.members) {
				if (this.visible && !this.visible.has(id)) continue;
				const n = this.nodeById.get(id);
				if (n) points.push({ x: n.x, y: n.y });
			}
			const pad = nodeR * (6 + 4 * box.level);
			const b = boxBounds(points, pad);
			if (!b) continue;
			const hue = clusterHue(box.id);
			ctx.strokeStyle = `hsla(${hue}, 55%, 70%, 0.55)`;
			ctx.beginPath();
			ctx.roundRect(b.x, b.y, b.w, b.h, pad * 0.6);
			ctx.stroke();
			ctx.fillStyle = `hsla(${hue}, 55%, 78%, 0.9)`;
			ctx.fillText(box.label, b.x + 4 / k, b.y - 3 / k);
		}
		ctx.restore();
	}
```

In `draw()` right after the `// 1. Cluster regions` block (after its closing brace, before `// 3. Edges`) add:

```ts
		// 2. Expanded-group boxes (2026-10-27): above the region tint, under
		//    the edges and nodes.
		this.drawGroupBoxes(ctx, k);
```

- [ ] **Step 4: Run and verify pass**

Run: `NODE_ENV=test npx tsx --test tests/graph-canvas.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Wire graph-view**

In `components/graph-view.tsx`:

1. Import: `import { GROUP_NODE_PREFIX, isGroupNodeId, projectGroups } from "./group-projection.ts";`
2. Next to the other state (after `const [selected, setSelected]`, line ~981) add:

```ts
	// GROUP COLLAPSE (2026-10-27): which groups are collapsed into a blob.
	// Starts empty on every load — groups start expanded. Display state only.
	const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
	const toggleGroup = useCallback((groupId: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			return next;
		});
	}, []);
	// The renderer callbacks are built once — they reach the toggle and the
	// current blob ids through refs.
	const toggleGroupRef = useRef(toggleGroup);
	toggleGroupRef.current = toggleGroup;
	const blobIdsRef = useRef<ReadonlySet<string>>(new Set());
```

3. In `onSelect` (line 1348) insert as the first statement:

```ts
						if (isGroupNodeId(nodeId)) {
							// A collapsed group blob: a click expands it in place.
							toggleGroupRef.current(nodeId.slice(GROUP_NODE_PREFIX.length));
							return;
						}
```

4. Replace the body of Feed #1's `renderer.setData({...})` call with:

```ts
		const projection = projectGroups(
			{
				nodes: snapshot.nodes,
				propositions: snapshot.propositions,
				edges: snapshot.edges,
				logicalEdges: snapshot.logicalEdges,
				impLinks: snapshot.impLinks,
				clusters: snapshot.clusters,
				groups: snapshot.groups,
				sessionGroups: snapshot.sessionGroups,
				collapsed: collapsedGroups,
			},
			(id) => positions.get(id) ?? { x: 0, y: 0 },
		);
		blobIdsRef.current = new Set(projection.blobIds);
		renderer.setData({
			nodes: projection.nodes,
			edges: projection.edges,
			logicalEdges: projection.logicalEdges,
			impLinks: projection.impLinks,
			clusters: projection.clusters,
			groupBoxes: projection.groupBoxes,
			colors: {
				node: tokenHex(NODE_COLOR_TOKEN),
				edge: tokenHex("--ring"),
				label: tokenHex("--muted-foreground"),
				hoverText: tokenHex("--foreground"),
			},
			// Match the app typography (Geist via the body's stack).
			fontFamily: getComputedStyle(document.body).fontFamily,
		});
```

and change the effect's dependency array from `[snapshot, isEmpty]` to `[snapshot, isEmpty, collapsedGroups]`.

5. In Feed #3 change the body to:

```ts
		// Collapsed group blobs are never search-filtered out (they stand
		// for every member underneath).
		rendererRef.current?.setVisible(query.trim() ? new Set([...visibleIds, ...blobIdsRef.current]) : null);
```

with deps `[visibleIds, query, snapshot, collapsedGroups]`.

- [ ] **Step 6: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS. Fix any existing graph-view test whose snapshot fixture now needs `groups: []` / `sessionGroups: {}`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(groups): canvas group boxes and collapse feed"
```

---

### Task 10: Groups panel (create, rename, move, delete, collapse)

**Files:**
- Create: `components/group-tree.ts`, `components/groups-client.ts`, `components/groups-panel.tsx`
- Modify: `components/graph-view.tsx` (`GraphChromeRow` line 840-913, `GraphView` body, render near line 1600)
- Test: `tests/group-tree.test.ts`, `tests/groups-panel.test.tsx`

**Interfaces:**
- Consumes: `GraphGroup`, `groupAndDescendants`-equivalent via `descendantGroupIds`, `groupPathLabel` (Task 1); the HTTP API (Task 4); `collapsedGroups`/`toggleGroup` (Task 9).
- Produces:
  - `buildGroupTree(groups, sessionGroups, sessionLabels): { roots: GroupNode[]; ungrouped: SessionRow[] }`, `moveTargets(groups, groupId): { id: string; label: string }[]`
  - `groupsClient`: `createGroup(name, parentGroupId?)`, `renameGroup(id, name)`, `moveGroup(id, parentGroupId | null)`, `deleteGroup(id)`, `moveSessions(groupId | null, sessionIds)`; each resolves to `{ ok: true } | { ok: false; error: string }` and dispatches `lh:graph-revision` on success
  - `<GroupsPanel groups sessionGroups sessionLabels collapsed onToggleCollapse onClose />`
  - `GraphChromeRow` optional prop `onOpenGroups?: () => void`

- [ ] **Step 1: Failing tests for the pure tree**

Create `tests/group-tree.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGroupTree, moveTargets } from "../components/group-tree.ts";

const groups = [
	{ id: "g1", name: "FINA 411" },
	{ id: "g2", name: "Risk", parentGroupId: "g1" },
	{ id: "g3", name: "Another" },
];
const labels = { s1: "Ch 01.md", s2: "Ch 05.md", s3: "Loose chat", gone: "x" };

describe("buildGroupTree", () => {
	it("nests groups, attaches sessions, counts deeply and lists ungrouped sessions", () => {
		const t = buildGroupTree(groups, { s1: "g1", s2: "g2" }, { s1: "Ch 01.md", s2: "Ch 05.md", s3: "Loose chat" });
		assert.deepEqual(t.roots.map((r) => r.group.id), ["g3", "g1"]); // name-sorted: Another, FINA 411
		const fina = t.roots.find((r) => r.group.id === "g1")!;
		assert.deepEqual(fina.children.map((c) => c.group.id), ["g2"]);
		assert.deepEqual(fina.sessions.map((s) => s.id), ["s1"]);
		assert.equal(fina.sessionCount, 2);
		assert.deepEqual(t.ungrouped.map((s) => s.id), ["s3"]);
	});
	it("ignores session entries whose session is gone", () => {
		const t = buildGroupTree(groups, { ghost: "g1" }, labels);
		assert.equal(t.roots.find((r) => r.group.id === "g1")!.sessions.length, 0);
	});
});

describe("moveTargets", () => {
	it("excludes the group itself and its descendants and labels by path", () => {
		assert.deepEqual(moveTargets(groups, "g1").map((t) => t.id), ["g3"]);
		assert.deepEqual(moveTargets(groups, "g2").map((t) => t.label), ["Another", "FINA 411"]);
	});
});
```

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/group-tree.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `components/group-tree.ts`**

```ts
import type { GraphGroup } from "../src/core/contracts.ts";
import { descendantGroupIds, groupPathLabel } from "../src/core/groups.ts";

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
```

- [ ] **Step 4: Run and verify pass**

Run: `NODE_ENV=test npx tsx --test tests/group-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: The client**

Create `components/groups-client.ts`:

```ts
/** Groups API client (2026-10-27). Every success announces the new
 *  graphRevision so the graph view's existing refetch chain runs. */
export type GroupsResult = { ok: true } | { ok: false; error: string };

async function call(url: string, method: string, body?: unknown): Promise<GroupsResult> {
	try {
		const res = await fetch(url, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const json = (await res.json().catch(() => ({}))) as { error?: string; graphRevision?: number };
		if (!res.ok) return { ok: false, error: json.error ?? `Request failed (HTTP ${res.status})` };
		window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { graphRevision: json.graphRevision } }));
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export const groupsClient = {
	createGroup: (name: string, parentGroupId?: string) => call("/api/graph/groups", "POST", { name, parentGroupId }),
	renameGroup: (id: string, name: string) => call(`/api/graph/groups/${encodeURIComponent(id)}`, "PATCH", { name }),
	moveGroup: (id: string, parentGroupId: string | null) => call(`/api/graph/groups/${encodeURIComponent(id)}`, "PATCH", { parentGroupId }),
	deleteGroup: (id: string) => call(`/api/graph/groups/${encodeURIComponent(id)}`, "DELETE"),
	moveSessions: (groupId: string | null, sessionIds: string[]) => call("/api/graph/groups/sessions", "PUT", { groupId, sessionIds }),
};
```

- [ ] **Step 6: The panel component**

Create `components/groups-panel.tsx`. Behavior (all of it must exist; the structure is fixed, the Tailwind classes follow `components/chain-table.tsx` / the graph-view popovers):

```tsx
"use client";

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FileTextIcon, FolderIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { GraphGroup } from "@/src/core";
import { buildGroupTree, moveTargets, type GroupNode, type SessionRow } from "./group-tree.ts";
import { groupsClient, type GroupsResult } from "./groups-client.ts";

export interface GroupsPanelProps {
	groups: readonly GraphGroup[];
	sessionGroups: Readonly<Record<string, string>>;
	/** Every nameable session: chat titles + notes file paths. */
	sessionLabels: Readonly<Record<string, string>>;
	/** Groups currently collapsed on the canvas. */
	collapsed: ReadonlySet<string>;
	onToggleCollapse: (groupId: string) => void;
	onClose: () => void;
}

export function GroupsPanel(props: GroupsPanelProps) {
	const { groups, sessionGroups, sessionLabels, collapsed, onToggleCollapse, onClose } = props;
	const tree = buildGroupTree(groups, sessionGroups, sessionLabels);
	const [newName, setNewName] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	/** Run a mutation; surface a refusal inline, clear it on success. */
	const run = async (p: Promise<GroupsResult>) => {
		const r = await p;
		setError(r.ok ? null : r.error);
		return r.ok;
	};
	/** "Move to…" for a session: a native select — "" keeps, "__none" ungroups. */
	const sessionMove = (s: SessionRow, current: string | undefined) => (
		<select
			aria-label={`Move ${s.label} to group`}
			value={current ?? "__none"}
			onChange={(e) => void run(groupsClient.moveSessions(e.target.value === "__none" ? null : e.target.value, [s.id]))}
			className="h-6 max-w-32 rounded border bg-background text-[11px]"
		>
			<option value="__none">Ungrouped</option>
			{moveTargets(groups, "").map((t) => (
				<option key={t.id} value={t.id}>{t.label}</option>
			))}
		</select>
	);

	const renderGroup = (node: GroupNode, depth: number): React.ReactNode => {
		const g = node.group;
		const isCollapsed = collapsed.has(g.id);
		return (
			<div key={g.id}>
				<div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: depth * 12 }} data-testid={`group-row-${g.id}`}>
					<button type="button" aria-label={isCollapsed ? `Expand ${g.name}` : `Collapse ${g.name}`} aria-pressed={isCollapsed}
						onClick={() => onToggleCollapse(g.id)} className="rounded p-0.5 hover:bg-accent">
						{isCollapsed ? <ChevronRightIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
					</button>
					<FolderIcon className="size-3 shrink-0 text-muted-foreground" />
					{editing === g.id ? (
						<input autoFocus defaultValue={g.name} aria-label={`Rename ${g.name}`}
							onKeyDown={(e) => {
								if (e.key === "Escape") setEditing(null);
								if (e.key === "Enter") void run(groupsClient.renameGroup(g.id, e.currentTarget.value)).then((ok) => ok && setEditing(null));
							}}
							onBlur={() => setEditing(null)}
							className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-xs" />
					) : (
						<span className="min-w-0 flex-1 truncate text-xs">{g.name} <span className="text-muted-foreground">({node.sessionCount})</span></span>
					)}
					<select aria-label={`Move group ${g.name}`} value={g.parentGroupId ?? "__none"}
						onChange={(e) => void run(groupsClient.moveGroup(g.id, e.target.value === "__none" ? null : e.target.value))}
						className="h-6 max-w-28 rounded border bg-background text-[11px]">
						<option value="__none">Top level</option>
						{moveTargets(groups, g.id).map((t) => (<option key={t.id} value={t.id}>{t.label}</option>))}
					</select>
					<button type="button" aria-label={`Rename ${g.name}`} onClick={() => setEditing(g.id)} className="rounded p-0.5 hover:bg-accent"><PencilIcon className="size-3" /></button>
					<button type="button" aria-label={`Delete ${g.name}`} onClick={() => setConfirmDelete(g.id)} className="rounded p-0.5 hover:bg-accent"><Trash2Icon className="size-3" /></button>
				</div>
				{confirmDelete === g.id && (
					<div role="alertdialog" className="my-1 rounded-md border bg-card p-2 text-xs" style={{ marginLeft: depth * 12 + 16 }}>
						Delete group “{g.name}”? Its subgroups and sessions move up one level; no nodes or chains change.
						<div className="mt-1.5 flex gap-1.5">
							<button type="button" onClick={() => setConfirmDelete(null)} className="rounded border px-2 py-0.5">Cancel</button>
							<button type="button" onClick={() => void run(groupsClient.deleteGroup(g.id)).then(() => setConfirmDelete(null))}
								className="rounded border border-destructive px-2 py-0.5 text-destructive">Delete</button>
						</div>
					</div>
				)}
				{!isCollapsed && (
					<>
						{node.children.map((c) => renderGroup(c, depth + 1))}
						{node.sessions.map((s) => (
							<div key={s.id} className="flex items-center gap-1 py-0.5" style={{ paddingLeft: (depth + 1) * 12 + 16 }}>
								<FileTextIcon className="size-3 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate text-xs">{s.label}</span>
								{sessionMove(s, g.id)}
							</div>
						))}
					</>
				)}
			</div>
		);
	};

	return (
		<div role="dialog" aria-label="Groups" data-testid="groups-panel"
			className="lh-no-drag absolute right-2 top-12 z-30 flex max-h-[70%] w-96 max-w-[calc(100%-1rem)] flex-col rounded-xl border bg-card p-3 text-left shadow-lg">
			<div className="mb-2 flex items-center justify-between">
				<h2 className="text-sm font-semibold">Groups</h2>
				<button type="button" aria-label="Close groups" onClick={onClose} className="rounded p-0.5 hover:bg-accent"><XIcon className="size-3.5" /></button>
			</div>
			<form className="mb-2 flex gap-1.5" onSubmit={(e) => {
				e.preventDefault();
				if (newName.trim() === "") return;
				void run(groupsClient.createGroup(newName)).then((ok) => ok && setNewName(""));
			}}>
				<input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New group…" aria-label="New group name"
					className="h-7 min-w-0 flex-1 rounded-lg border bg-background px-2 text-xs" />
				<button type="submit" aria-label="Create group" className="flex h-7 items-center rounded-lg border px-2 text-xs hover:bg-accent"><PlusIcon className="size-3" /></button>
			</form>
			{error && <p role="alert" className="mb-2 text-xs text-destructive">{error}</p>}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{tree.roots.map((r) => renderGroup(r, 0))}
				{tree.ungrouped.length > 0 && (
					<div className="mt-2">
						<div className="text-[11px] uppercase tracking-wide text-muted-foreground">Ungrouped</div>
						{tree.ungrouped.map((s) => (
							<div key={s.id} className="flex items-center gap-1 py-0.5">
								<FileTextIcon className="size-3 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate text-xs">{s.label}</span>
								{sessionMove(s, undefined)}
							</div>
						))}
					</div>
				)}
				{tree.roots.length === 0 && tree.ungrouped.length === 0 && <p className="text-xs text-muted-foreground">No sessions yet.</p>}
			</div>
		</div>
	);
}
```

Note `moveTargets(groups, "")` in `sessionMove` returns every group (nothing is banned for the empty id) — that is intended for sessions.

- [ ] **Step 7: SSR pins for the panel**

Create `tests/groups-panel.test.tsx` following `tests/delete-node-dialog.test.tsx` (`renderToStaticMarkup`):

```tsx
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupsPanel } from "../components/groups-panel.tsx";

const render = (collapsed: string[] = []) =>
	renderToStaticMarkup(
		createElement(GroupsPanel, {
			groups: [{ id: "g1", name: "FINA 411" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
			sessionGroups: { s1: "g2" },
			sessionLabels: { s1: "Ch 05.md", s2: "Loose chat" },
			collapsed: new Set(collapsed),
			onToggleCollapse: () => {},
			onClose: () => {},
		}),
	);

describe("GroupsPanel", () => {
	it("lists nested groups, their sessions and ungrouped sessions", () => {
		const html = render();
		assert.match(html, /FINA 411/);
		assert.match(html, /Risk/);
		assert.match(html, /Ch 05\.md/);
		assert.match(html, /Ungrouped/);
		assert.match(html, /Loose chat/);
	});
	it("hides a collapsed group's contents and marks its toggle pressed", () => {
		const html = render(["g1"]);
		assert.doesNotMatch(html, /Ch 05\.md/);
		assert.match(html, /aria-pressed="true"/);
	});
});
```

- [ ] **Step 8: Mount the panel**

In `components/graph-view.tsx`:

- Add `FolderTreeIcon` to the lucide import (line 69) and `import { GroupsPanel } from "@/components/groups-panel.tsx";`.
- `GraphChromeRow`: add optional prop `onOpenGroups?: () => void;` (doc: opens the Groups panel) and render, directly after the Chains block (after line 912) and before Import:

```tsx
				{!isEmpty && onOpenGroups && (
					<div className="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
						<Hint label="Group sessions into collapsible groups" side="bottom">
							<button
								type="button"
								onClick={onOpenGroups}
								data-testid="open-groups"
								className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
							>
								<FolderTreeIcon className="size-3" />
								Groups
							</button>
						</Hint>
					</div>
				)}
```

- `GraphView`: add `const [groupsOpen, setGroupsOpen] = useState(false);`, pass `onOpenGroups={() => setGroupsOpen((o) => !o)}` to `<GraphChromeRow ... />`, and render before `<ChainTableOverlay`:

```tsx
				{groupsOpen && snapshot && !isEmpty && (
					<GroupsPanel
						groups={snapshot.groups}
						sessionGroups={snapshot.sessionGroups}
						sessionLabels={{ ...snapshot.fileSources, ...snapshot.sessions }}
						collapsed={collapsedGroups}
						onToggleCollapse={toggleGroup}
						onClose={() => setGroupsOpen(false)}
					/>
				)}
```

(`ChainTableOverlay` must stay the LAST child — see its DOM-order comment; insert the panel above it.)

- [ ] **Step 9: Run**

Run: `NODE_ENV=test npx tsx --test tests/group-tree.test.ts tests/groups-panel.test.tsx tests/graph-view-filters.test.ts && npm run typecheck && npm run lint`
Expected: PASS. If an existing `GraphChromeRow` SSR pin breaks, it means the new prop was made required; keep it optional.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(groups): groups panel with create, rename, move, delete and collapse"
```

---

### Task 11: Folder picker and drag-and-drop

**Files:**
- Create: `components/folder-import.ts`
- Modify: `components/graph-view.tsx` (`GraphChromeRow` import block lines 914-946, root container line 1508)
- Test: `tests/folder-import.test.ts`

**Interfaces:**
- Consumes: `useNotesImport().onImportEntries` (Task 5).
- Produces: `PickedFile { file: File; path: string }`, `importableEntries(entries)`, `entriesFromFileList(list)`, `entriesFromDrop(dt)`; `GraphChromeRow` optional props `onImportFolder?: (list: FileList | null) => void` and `folderInputRef?: React.RefObject<HTMLInputElement | null>`.

- [ ] **Step 1: Failing tests for the pure filter**

Create `tests/folder-import.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importableEntries, type PickedFile } from "../components/folder-import.ts";

const entry = (path: string): PickedFile => ({ file: new File(["x"], path.split("/").pop()!), path });

describe("importableEntries", () => {
	it("keeps only .md / .markdown / .txt", () => {
		const kept = importableEntries([entry("V/a.md"), entry("V/b.MARKDOWN"), entry("V/c.txt"), entry("V/d.png"), entry("V/e.pdf")]);
		assert.deepEqual(kept.map((e) => e.path), ["V/a.md", "V/b.MARKDOWN", "V/c.txt"]);
	});
	it("skips hidden files and anything under a hidden directory", () => {
		const kept = importableEntries([entry("V/.obsidian/x.md"), entry("V/.hidden.md"), entry("V/.git/y.txt"), entry("V/ok.md")]);
		assert.deepEqual(kept.map((e) => e.path), ["V/ok.md"]);
	});
});
```

- [ ] **Step 2: Run and verify failure**

Run: `NODE_ENV=test npx tsx --test tests/folder-import.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `components/folder-import.ts`**

```ts
/**
 * FOLDER IMPORT collection (2026-10-27): turns a picked folder
 * (<input webkitdirectory>) or a dropped one (DataTransfer entries) into a
 * flat list of { file, path } where path is the file's path RELATIVE to
 * the dropped folder's parent ("Vault/Sub/Note.md"). Importable = the
 * picker's accept list (.md/.markdown/.txt); hidden files and directories
 * (".obsidian", ".git", …) are skipped without being walked.
 */
export interface PickedFile {
	file: File;
	path: string;
}

const IMPORTABLE = /\.(md|markdown|txt)$/i;

export function importableEntries(entries: readonly PickedFile[]): PickedFile[] {
	return entries.filter(({ path }) => IMPORTABLE.test(path) && !path.split("/").some((seg) => seg.startsWith(".")));
}

/** A folder chosen with <input webkitdirectory>. */
export function entriesFromFileList(list: FileList): PickedFile[] {
	return importableEntries(Array.from(list, (file) => ({ file, path: file.webkitRelativePath || file.name })));
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
	if (entry.name.startsWith(".")) return; // never descend into hidden dirs
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
		out.push({ file, path: prefix + entry.name });
		return;
	}
	if (entry.isDirectory) {
		const reader = (entry as FileSystemDirectoryEntry).createReader();
		for (;;) {
			// readEntries returns at most ~100 entries per call: loop until empty.
			const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
			if (batch.length === 0) break;
			for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
		}
	}
}

/** A drop: the entries must be read from `dt.items` SYNCHRONOUSLY (they die
 *  when the handler yields), then walked asynchronously. */
export async function entriesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
	const roots = Array.from(dt.items)
		.map((item) => item.webkitGetAsEntry?.() ?? null)
		.filter((e): e is FileSystemEntry => e !== null);
	const out: PickedFile[] = [];
	for (const root of roots) await walk(root, "", out);
	return importableEntries(out);
}
```

- [ ] **Step 4: Run and verify pass**

Run: `NODE_ENV=test npx tsx --test tests/folder-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Folder button and drop zone**

In `components/graph-view.tsx`:

- Import `import { entriesFromDrop, entriesFromFileList } from "@/components/folder-import.ts";` and `FolderUpIcon` from lucide.
- `GraphChromeRow`: add optional props `folderInputRef?: React.RefObject<HTMLInputElement | null>;` and `onImportFolder?: (list: FileList | null) => void;`. Inside the Import container (the `rounded-xl border bg-card/85 px-1 py-[3px]` div at line 916), after the existing `<Hint>…</Hint>` for "Import notes…", add:

```tsx
					{onImportFolder && folderInputRef && (
						<>
							<input
								ref={folderInputRef}
								type="file"
								className="hidden"
								// Non-standard but universal (Chromium/Electron): pick a folder.
								{...({ webkitdirectory: "" } as Record<string, string>)}
								onChange={(e) => {
									onImportFolder(e.target.files);
									e.target.value = "";
								}}
							/>
							<Hint label="Import a folder — its subfolders become groups" side="bottom">
								<button
									type="button"
									disabled={importing}
									onClick={() => folderInputRef.current?.click()}
									data-testid="import-folder"
									className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
								>
									<FolderUpIcon className="size-3" />
									Import folder…
								</button>
							</Hint>
						</>
					)}
```

- `GraphView`: add `const folderInputRef = useRef<HTMLInputElement>(null);` next to `fileInputRef`, destructure `onImportEntries` from `notesImport`, and pass to `GraphChromeRow`:

```tsx
					folderInputRef={folderInputRef}
					onImportFolder={(list) => { if (list) notesImport.onImportEntries(entriesFromFileList(list)); }}
```

- Drop zone: on the root `<div ref={containerRef} className="relative h-full w-full">` (line 1508) add `data-testid="graph-drop-zone"` and handlers, and a `dragging` state (`const [dragging, setDragging] = useState(false);`):

```tsx
					onDragOver={(e) => {
						if (!e.dataTransfer.types.includes("Files")) return;
						e.preventDefault();
						setDragging(true);
					}}
					onDragLeave={(e) => {
						if (e.currentTarget === e.target) setDragging(false);
					}}
					onDrop={(e) => {
						if (!e.dataTransfer.types.includes("Files")) return;
						e.preventDefault();
						setDragging(false);
						// Read the entries synchronously inside the handler (they die when it yields).
						void entriesFromDrop(e.dataTransfer).then((entries) => notesImport.onImportEntries(entries));
					}}
```

and render, as the last child inside that div, `{dragging && <div className="pointer-events-none absolute inset-2 z-10 rounded-xl border-2 border-dashed border-ring bg-ring/5 text-center text-sm text-muted-foreground flex items-center justify-center">Drop a folder to import it as a group</div>}`.

The empty-graph state (line ~1500, the `isEmpty` placeholder) is a different branch that has no container; add the same three handlers to that branch's outer element (the div wrapping "Start a session or import notes to build your graph.") so a first-ever import can also be a folder drop. Use the same handler functions (extract them into three `const`s above the return to avoid duplicating the body).

- [ ] **Step 6: Typecheck and run**

Run: `npm run typecheck && npm run lint && NODE_ENV=test npx tsx --test tests/folder-import.test.ts tests/notes-import.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(groups): folder picker and drag-and-drop import"
```

---

### Task 12: Verification, spec sync, and live check

**Files:**
- Modify: `docs/superpowers/specs/2026-10-27-session-groups-design.md`
- Modify: `skills/learnharness/references/data-format.md` (document groups.json)

- [ ] **Step 1: Sync the spec with the owner's later answers**

In the spec, under "Decisions", add: deleting a group re-parents its subgroups and directly-held sessions to its parent (ungrouped if none); `delete_group` is a code-enforced two-step with a one-time token; the agent group tools live on the teacher behind the graph-tools gate; group management is a Groups panel; the node-level `list_nodes`/`get_node` of the original request are replaced by the session-level read tools gaining a group filter and label. Remove "Deleting a group leaves its sessions ungrouped" wording that contradicts the re-parent rule.

- [ ] **Step 2: Document the file format**

`grep -n "sources.json" skills/learnharness/references/data-format.md` and add a short `groups.json` section next to it: shape `{ groups: [{id,name,parentGroupId?}], sessionGroups: { sessionId: groupId } }`, metadata only, format version 2.

- [ ] **Step 3: Full automated pass**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green. Fix any failing pre-existing test only by updating a fixture that legitimately gained `groups`/`sessionGroups`/`readGroups`; never weaken an assertion about ledgers. The golden-fixture test must stay green untouched (groups.json is absent there, reads are empty).

- [ ] **Step 4: Live check with the run skill**

Invoke the `run` skill to start the app (`npm run dev`), then in the built-in browser:

1. Import 3 markdown files via **Import notes…** with a configured model (or seed data with `scripts/dev-fresh.sh`), confirm clusters appear.
2. Open **Groups**, create "Course", move two sessions into it; confirm a dashed labeled box appears around their regions and the snapshot at `/api/graph` lists `groups`/`sessionGroups`.
3. Collapse the group via the chevron: one blob labeled "Course · N" replaces the members, cross-group chains still draw to the blob, region label shows when zoomed out. Click the blob: it expands.
4. Create a nested group, collapse the parent: outermost wins. Rename, move a group under another, delete one: sessions move up.
5. Make a folder `Vault/Sub/` with 2 `.md` files plus `Vault/.obsidian/x.md`; drop it on the graph: groups `Vault` and `Sub` are created, the `.obsidian` file is skipped, files are extracted.
6. Re-drop a folder containing a file whose bare name was imported earlier: it is placed in the group without a new extraction run in the activity dock.
7. In a teacher chat, with graph tools on, ask it to "list my groups", "create a group X with session …", then "delete group X": it must preview first and delete only after you confirm.
8. Delete a chat that was in a group: its membership disappears, no error.

Record anything that does not behave as above as a failing step and fix it before finishing; do not mark this task done on a partial pass.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "docs(groups): sync spec with design decisions, document groups.json"
```

---

## Self-review (completed)

- **Spec coverage:** data model (Task 1-2); sessions-in-groups and node inheritance (Tasks 3, 8); merges/deletes leave groups alone, chat-delete prune (Task 4); folder import with relative paths, group tree, bare-name reuse (Task 5); teacher tools with counts, two-step delete (Task 6); read-tool group filter/label replacing `list_nodes`/`get_node` (Task 7); labeled group boxes, collapse blob, bundled and cross-group chains, in-place expand (Tasks 8-9); Groups panel create/rename/move/delete (Task 10); drop and picker (Task 11); reversibility by inverse op, counts, format bump (Tasks 2, 4); verification (Task 12).
- **Placeholders:** Task 6 Step 5 and Task 7's test bodies reference existing file conventions rather than full literals; both name the exact file and pattern to copy, and Task 6 Step 5 is explicitly skippable. Everything else carries code.
- **Type consistency:** `GroupsState`/`GraphGroup` (Task 1) are used unchanged in Tasks 2-10; `groupApi`, `*Op` names match between Tasks 4, 6 and 10; `boxBounds`/`CanvasGroupBox` (Task 9) match `ProjectedGroupBox` (Task 8) field-for-field (`id,label,level,members`); `onImportEntries` (Task 5) is what Task 11 calls.
