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
	const reusedIds = new Set<string>();
	const createdIds = new Set<string>();
	let created = 0;
	for (const path of paths) {
		const dirs = path.split("/").slice(0, -1);
		let parent: string | undefined;
		for (const raw of dirs) {
			const name = raw.trim().replace(/\s+/g, " ").slice(0, GROUP_NAME_MAX);
			if (name === "") continue;
			const existing = current.groups.find((g) => g.name === name && g.parentGroupId === parent);
			if (existing) {
				// Groups created earlier in this same plan are not "reused".
				if (!createdIds.has(existing.id)) reusedIds.add(existing.id);
				parent = existing.id;
			} else {
				const id = mintId();
				current = createGroup(current, { id, name, parentGroupId: parent });
				createdIds.add(id);
				created++;
				parent = id;
			}
		}
		if (parent !== undefined) fileGroup.set(path, parent);
	}
	return { state: current, fileGroup, created, reused: reusedIds.size };
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
