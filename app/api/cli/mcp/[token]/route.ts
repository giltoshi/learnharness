import { handleCliMcp } from "@/src/server";

export const dynamic = "force-dynamic";

/** The MCP endpoint the Claude CLI calls during a turn. The unguessable per-turn token IS the credential; it dies when the turn ends. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
	const { token } = await params;
	const body = await req.json().catch(() => null);
	const reply = await handleCliMcp(token, body);
	if (reply === undefined) return Response.json({ error: "Not found" }, { status: 404 });
	if (reply === null) return new Response(null, { status: 202 });
	return Response.json(reply);
}

export async function GET() {
	return new Response(null, { status: 405 });
}
