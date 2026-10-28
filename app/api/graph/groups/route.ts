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
