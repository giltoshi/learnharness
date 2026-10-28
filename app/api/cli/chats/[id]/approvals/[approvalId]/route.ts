import { decideCliApproval, parseApprovalBody } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; approvalId: string }> }) {
	const { id, approvalId } = await params;
	const parsed = parseApprovalBody(await req.json().catch(() => null));
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	return decideCliApproval(id, approvalId, parsed.decision) ? Response.json({ ok: true }) : Response.json({ error: "No such pending approval" }, { status: 404 });
}
