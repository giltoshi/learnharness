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
