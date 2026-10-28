import { cliUndoInfo, undoCliGraphChange } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ undo: cliUndoInfo() });
}

export async function POST() {
	const r = undoCliGraphChange();
	if (r.ok) return Response.json({ label: r.value.label });
	return Response.json({ error: r.error, code: r.code }, { status: r.code === "nothing_to_undo" ? 404 : 409 });
}
