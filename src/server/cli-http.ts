/** Request-body parsing for the CLI routes — kept out of the route files so it is testable. */
import type { CliApprovalDecision } from "../core/contracts.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function parseTurnBody(body: unknown): { ok: true; text: string } | { ok: false; error: string } {
	if (!isRecord(body) || typeof body.text !== "string" || body.text.trim() === "") return { ok: false, error: "text is required" };
	return { ok: true, text: body.text.trim() };
}

export function parseApprovalBody(body: unknown): { ok: true; decision: CliApprovalDecision } | { ok: false; error: string } {
	if (!isRecord(body) || typeof body.approved !== "boolean") return { ok: false, error: "approved must be a boolean" };
	if (!body.approved) return { ok: true, decision: { approved: false } };
	if (body.edit === undefined) return { ok: true, decision: { approved: true } };
	const e = body.edit;
	if (!isRecord(e) || typeof e.name !== "string" || typeof e.statement !== "string") return { ok: false, error: "edit needs string name and statement" };
	if (e.name.trim() === "" || e.statement.trim() === "") return { ok: false, error: "edit name and statement must not be blank" };
	return { ok: true, decision: { approved: true, edit: { name: e.name, statement: e.statement } } };
}
