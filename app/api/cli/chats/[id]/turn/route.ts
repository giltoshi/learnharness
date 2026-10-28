import { parseTurnBody, runCliTurnStream } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const parsed = parseTurnBody(await req.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const out = runCliTurnStream(id, parsed.text, new URL(req.url).origin);
	if ("error" in out) {
		return out.error === "busy"
			? Response.json({ error: "A turn is already running in this chat", code: "busy" }, { status: 409 })
			: Response.json({ error: "Not found" }, { status: 404 });
	}
	return new Response(out, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}
