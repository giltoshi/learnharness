# Session groups and folder import: design

Date: 2026-10-27. Status: approved in conversation, awaiting spec review.

## Goal

Let the learner group birth-session clusters (one per chat or imported notes file) into named, nestable groups, e.g. one "FINA 411" group holding one cluster per chapter. In the graph view a group collapses into a single blob and expands in place. Dropping a vault folder auto-creates a group for the folder, with nested groups for its subfolders.

## Decisions (owner-confirmed)

1. A group contains sessions/clusters, not individual nodes. Nodes inherit their group through their birth session.
2. Groups are created and edited through the UI and through agent tools (delete needs approval).
3. Folder import mirrors the folder tree as groups. Dropped files whose bare name matches exactly one existing source reuse that source and are only placed in the group; ambiguous matches are treated as new.
4. Graph view: collapse and expand in place, with chains bundled to the blob edge and cross-group chains still visible.
5. No undo stack. Every group operation is reversible by its inverse operation, and tools return enough information to reverse it.

## Assumptions to confirm at review

- Groups start expanded on load.
- A group's label is its name; there is no auto-naming.

## 1. Data

- New file `data/graph/groups.json`, a plain JSON file like `sources.json` (not a ledger):
  - `groups: { id, name, parentGroupId? }[]`
  - `sessionGroups: Record<sessionId, groupId>`. A session belongs to at most one group. Session ids are chat ids or `src_...` ids.
- Nesting through `parentGroupId`; mutations reject cycles.
- Node and chain ledgers are not modified. Merges and deletes leave groups alone. An empty group persists until deleted. Deleting a session removes its `sessionGroups` entry.
- Bump `CURRENT_GRAPH_FORMAT_VERSION` so older builds refuse the data (`src/store/graph-format.ts`).
- New `GraphStore` port methods for reading and atomically rewriting groups.

## 2. Folder import

- The client sends each file's relative path (`FINA 411/Ch 01.md`) instead of `file.name`. `app/api/graph/import/route.ts` and `components/notes-import.tsx` currently validate and key on `file.name`; both change.
- Source ids stay deterministic per path, which also fixes same-named files in different subfolders colliding.
- Matching: if a file's name equals exactly one existing source's bare name, reuse that source and skip extraction.
- Group creation: a root group named after the dropped folder, nested groups per subfolder, each session assigned to its folder's group. Re-dropping the same folder reuses existing groups with the same name under the same parent.

## 3. Agent tools

Registered alongside the existing graph tools in `src/agent/tools/graph.ts`, behind the same graph-tools gate.

- `create_group(name, parentGroupId?, sessionIds?)` returns the group id.
- `add_sessions_to_group(groupId, sessionIds[])` moves sessions, including ones already in another group.
- `remove_sessions_from_group(sessionIds[])`
- `rename_group(groupId, name)`
- `delete_group(groupId)` removes the group, leaves its sessions ungrouped, needs approval.
- `list_groups()` returns `id | name | parent | session count | node count`.
- `list_sessions` and `list_propositions` gain an optional `groupId` filter, and `list_sessions` output shows each session's group. This replaces the spec's node-level `list_nodes` and `get_node`, which do not exist in this app.
- Mutating tools return counts, e.g. "moved 12 sessions (340 nodes) into 'Risk & Return', 0 chains affected".

## 4. UI (`components/graph-view.tsx`, `components/cluster-geometry.ts`, `src/core/clusters.ts`)

- Group hulls drawn around member session hulls, labeled with the group name.
- Click a group to collapse it into one blob with its chains bundled to the edge. Click again to expand in place. Chains crossing groups stay drawn.
- Controls to create, rename, delete groups and move sessions.
- The snapshot payload gains groups and each cluster's group id.

## Testing

Unit tests for group mutations (cycle rejection, move, delete leaves sessions, session deletion cleanup), folder-path-to-group derivation, bare-name matching, and tool output counts. Existing graph, layout and golden-fixture tests must stay green, since grouping must not alter node or chain data.
