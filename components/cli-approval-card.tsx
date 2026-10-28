"use client";

import { useState } from "react";
import type { CliApproval, CliApprovalEdit } from "@/src/core";

/** The in-chat approval card: what will change, optional editable identity, Approve / Reject. */
export function ApprovalCard({ approval, onDecide, disabled = false }: { approval: CliApproval; disabled?: boolean; onDecide: (approved: boolean, edit?: CliApprovalEdit) => void }) {
	const [name, setName] = useState(approval.edit?.name ?? "");
	const [statement, setStatement] = useState(approval.edit?.statement ?? "");
	const pending = approval.status === "pending";
	const blank = approval.edit !== undefined && (name.trim() === "" || statement.trim() === "");
	return (
		<div className="rounded-lg border border-border bg-card p-3 text-sm" data-testid="approval-card">
			<div className="font-medium">{approval.title}</div>
			<ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
				{approval.lines.map((l, i) => <li key={i}>{l}</li>)}
			</ul>
			{approval.edit && pending && (
				<div className="mt-3 space-y-2">
					<label className="block text-xs uppercase tracking-wider text-muted-foreground">Name
						<input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm normal-case tracking-normal text-foreground" value={name} onChange={(e) => setName(e.target.value)} />
					</label>
					<label className="block text-xs uppercase tracking-wider text-muted-foreground">Statement
						<textarea className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm normal-case tracking-normal text-foreground" rows={3} value={statement} onChange={(e) => setStatement(e.target.value)} />
					</label>
				</div>
			)}
			{pending ? (
				<div className="mt-3 flex gap-2">
					<button type="button" className="rounded-md bg-foreground px-3 py-1 text-xs text-background disabled:opacity-50" disabled={disabled || blank} aria-disabled={disabled || blank} onClick={() => onDecide(true, approval.edit ? { name, statement } : undefined)}>Approve</button>
					<button type="button" className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-50" disabled={disabled} aria-disabled={disabled} onClick={() => onDecide(false)}>Reject</button>
					{blank && <span className="self-center text-xs text-muted-foreground">Name and statement are required to approve.</span>}
				</div>
			) : (
				<div className="mt-2 text-xs uppercase tracking-wider text-muted-foreground">{approval.status === "approved" ? "Approved" : "Rejected"}</div>
			)}
		</div>
	);
}
