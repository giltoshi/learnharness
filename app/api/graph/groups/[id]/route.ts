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
