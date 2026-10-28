/**
 * The approval broker: destructive tools park here until the learner answers
 * the card. In-memory by design — an approval only means something while the
 * turn that asked is alive, so nothing outlives the process. Every request
 * is chat-scoped: a decision for one chat can never resolve another's.
 */
import { randomUUID } from "node:crypto";
import type { CliApprovalDecision, CliApprovalRequest, CliWireEvent } from "../core/contracts.ts";

interface Pending {
	chatId: string;
	resolve(d: CliApprovalDecision): void;
	timer?: ReturnType<typeof setTimeout>;
	emit(e: CliWireEvent): void;
}

/** Just under the CLI's 600 s MCP tool timeout: after that Claude has been told the call failed. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 9 * 60_000;

export function createApprovalBroker(newId: () => string = () => randomUUID(), options: { timeoutMs?: number } = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
	const pending = new Map<string, Pending>();

	function settle(id: string, decision: CliApprovalDecision): void {
		const p = pending.get(id);
		if (!p) return;
		pending.delete(id);
		if (p.timer) clearTimeout(p.timer);
		p.emit({ type: "approval-settled", id, approved: decision.approved });
		p.resolve(decision);
	}

	return {
		request(chatId: string, req: CliApprovalRequest, emit: (e: CliWireEvent) => void): Promise<CliApprovalDecision> {
			const id = newId();
			return new Promise((resolve) => {
				const entry: Pending = { chatId, resolve, emit };
				entry.timer = setTimeout(() => settle(id, { approved: false }), timeoutMs);
				entry.timer.unref?.();
				pending.set(id, entry);
				emit({ type: "approval", approval: { id, tool: req.tool, title: req.title, lines: req.lines, ...(req.edit ? { edit: req.edit } : {}), status: "pending" } });
			});
		},
		decide(chatId: string, approvalId: string, decision: CliApprovalDecision): boolean {
			const p = pending.get(approvalId);
			if (!p || p.chatId !== chatId) return false;
			settle(approvalId, decision);
			return true;
		},
		rejectAll(chatId: string): void {
			for (const [id, p] of [...pending]) if (p.chatId === chatId) settle(id, { approved: false });
		},
		pendingCount(chatId: string): number {
			return [...pending.values()].filter((p) => p.chatId === chatId).length;
		},
	};
}
export type ApprovalBroker = ReturnType<typeof createApprovalBroker>;
