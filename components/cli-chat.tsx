"use client";

/**
 * The Claude CLI chat view. A turn is a POST whose NDJSON response is folded
 * with applyWireEvent (the same reducer the server persists with). Approval
 * cards answer through the approvals route; the turn stream settles them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { ApprovalCard } from "@/components/cli-approval-card";
import { toolSummary } from "@/components/cli-format";
import { TopBar } from "@/components/top-bar";
import { applyWireEvent, newCliMessage, type CliApprovalEdit, type CliMessage, type CliWireEvent } from "@/src/core";

export function CliMessageView({ message, onDecide }: { message: CliMessage; onDecide: (approvalId: string, approved: boolean, edit?: CliApprovalEdit) => void }) {
	return (
		<Message from={message.role}>
			<MessageContent>
				{message.parts.map((p, i) => {
					if (p.type === "text") return message.role === "user" ? <span key={i} className="whitespace-pre-wrap">{p.text}</span> : <MessageResponse key={i}>{p.text}</MessageResponse>;
					if (p.type === "tool") return <div key={i} className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground" title={p.call.output}>{toolSummary(p.call)} · {p.call.status}</div>;
					if (p.type === "approval") return <ApprovalCard key={i} approval={p.approval} onDecide={(a, e) => onDecide(p.approval.id, a, e)} />;
					return <div key={i} className="text-sm text-destructive">{p.message}</div>;
				})}
			</MessageContent>
		</Message>
	);
}

export function CliChat({ chatId, title, initialMessages }: { chatId: string; title: string; initialMessages: CliMessage[] }) {
	const [messages, setMessages] = useState<CliMessage[]>(initialMessages);
	const [busy, setBusy] = useState(false);
	const [text, setText] = useState("");
	const [undo, setUndo] = useState<{ label: string } | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const refreshUndo = useCallback(() => {
		fetch("/api/cli/undo").then((r) => r.json() as Promise<{ undo: { label: string } | null }>).then((j) => setUndo(j.undo)).catch(() => {});
	}, []);
	useEffect(refreshUndo, [refreshUndo]);

	const send = useCallback(async () => {
		const prompt = text.trim();
		if (prompt === "" || busy) return;
		setText("");
		setBusy(true);
		const stamp = Date.now().toString(36);
		const now = new Date().toISOString();
		let assistant = newCliMessage("assistant", `${stamp}-a`, now);
		setMessages((m) => [...m, newCliMessage("user", `${stamp}-u`, now, prompt), assistant]);
		const ac = new AbortController();
		abortRef.current = ac;
		const apply = (ev: CliWireEvent) => {
			if (ev.type === "usage") window.dispatchEvent(new CustomEvent("lh:cli-usage", { detail: ev.usage }));
			assistant = applyWireEvent(assistant, ev);
			setMessages((m) => [...m.slice(0, -1), assistant]);
		};
		try {
			const res = await fetch(`/api/cli/chats/${chatId}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: prompt }), signal: ac.signal });
			if (!res.ok || !res.body) {
				const j = (await res.json().catch(() => ({}))) as { error?: string };
				apply({ type: "error", message: j.error ?? `Request failed (${res.status})` });
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line) apply(JSON.parse(line) as CliWireEvent);
				}
			}
		} catch (err) {
			if (!ac.signal.aborted) apply({ type: "error", message: err instanceof Error ? err.message : String(err) });
		} finally {
			setBusy(false);
			abortRef.current = null;
			refreshUndo();
		}
	}, [text, busy, chatId, refreshUndo]);

	const decide = useCallback((approvalId: string, approved: boolean, edit?: CliApprovalEdit) => {
		void fetch(`/api/cli/chats/${chatId}/approvals/${approvalId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved, ...(edit ? { edit } : {}) }) });
	}, [chatId]);

	const doUndo = useCallback(async () => {
		const res = await fetch("/api/cli/undo", { method: "POST" });
		if (!res.ok) {
			const j = (await res.json().catch(() => ({}))) as { error?: string };
			setMessages((m) => [...m, { id: `${Date.now()}-e`, role: "assistant", createdAt: new Date().toISOString(), parts: [{ type: "error", message: j.error ?? "Undo failed" }] }]);
		}
		refreshUndo();
	}, [refreshUndo]);

	return (
		<div className="flex h-dvh flex-col">
			<TopBar><h1 className="font-title text-3xl tracking-tight">{title}</h1></TopBar>
			{undo && !busy && (
				<div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs">
					<span className="text-muted-foreground">{undo.label}</span>
					<button type="button" className="rounded-md border border-border px-2 py-0.5" onClick={() => void doUndo()}>Undo</button>
				</div>
			)}
			<Conversation className="min-h-0 flex-1">
				<ConversationContent>
					{messages.map((m) => <CliMessageView key={m.id} message={m} onDecide={decide} />)}
				</ConversationContent>
			</Conversation>
			<form className="flex gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
				<textarea className="min-h-10 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm" rows={2} placeholder="Ask Claude to tidy your nodes or chats…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
				{busy ? <button type="button" className="rounded-md border border-border px-3 text-sm" onClick={() => abortRef.current?.abort()}>Stop</button> : <button type="submit" className="rounded-md bg-foreground px-3 text-sm text-background" disabled={text.trim() === ""}>Send</button>}
			</form>
		</div>
	);
}
