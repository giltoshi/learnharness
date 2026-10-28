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
	emit(e: CliWireEvent): void;
}

export function createApprovalBroker(newId: () => string = () => randomUUID()) {
	const pending = new Map<string, Pending>();

	function settle(id: string, decision: CliApprovalDecision): void {
		const p = pending.get(id);
		if (!p) return;
		pending.delete(id);
		p.emit({ type: "approval-settled", id, approved: decision.approved });
		p.resolve(decision);
	}

	return {
		request(chatId: string, req: CliApprovalRequest, emit: (e: CliWireEvent) => void): Promise<CliApprovalDecision> {
			const id = newId();
			return new Promise((resolve) => {
				pending.set(id, { chatId, resolve, emit });
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
