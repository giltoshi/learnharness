import { deleteCliChat, getCliChat, renameCliChat } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getCliChat(id);
	return chat ? Response.json(chat) : Response.json({ error: "Not found" }, { status: 404 });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getCliChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string" || body.title.trim() === "") return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	return Response.json({ title: renameCliChat(id, body.title).title });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return deleteCliChat(id) ? Response.json({ ok: true }) : Response.json({ error: "Not found" }, { status: 404 });
}
