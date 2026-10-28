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
