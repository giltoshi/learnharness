"use client";

import { useState, type ReactNode } from "react";
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

	const renderGroup = (node: GroupNode, depth: number): ReactNode => {
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
