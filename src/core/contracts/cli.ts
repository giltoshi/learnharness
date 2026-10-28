/**
 * Claude CLI chat contracts — the chat record, the NDJSON wire vocabulary a
 * turn streams to the browser, the plan-limit snapshot, and the graph undo
 * record. Pure types; the reducer is core/cli-chat.ts.
 */
import type { CoverageEntry, GraphChain, GraphNode, Position, SessionCheckpoint } from "./graph.ts";

/** One plan window as reported by the CLI's rate_limit_event. */
export interface UsageWindow {
	/** 0..1 fraction of the window used. */
	utilization: number;
	/** Epoch SECONDS when the window resets. */
	resetsAt: number;
	status: string;
}

export interface UsageSnapshot {
	fiveHour: UsageWindow | null;
	sevenDay: UsageWindow | null;
	/** ISO — when the CLI reported it (drives the "as of" staleness label). */
	capturedAt: string;
}

export interface CliToolCall {
	id: string;
	/** Tool name WITHOUT the mcp__lh__ prefix. */
	name: string;
	input: unknown;
	status: "running" | "done" | "error";
	output?: string;
}

export interface CliApprovalEdit {
	name: string;
	statement: string;
}

export interface CliApproval {
	id: string;
	tool: string;
	title: string;
	lines: string[];
	/** Present for merge_nodes: the proposed identity, editable before approving. */
	edit?: CliApprovalEdit;
	status: "pending" | "approved" | "rejected";
}

export type CliPart =
	| { type: "text"; text: string }
	| { type: "tool"; call: CliToolCall }
	| { type: "approval"; approval: CliApproval }
	| { type: "error"; message: string };

export interface CliMessage {
	id: string;
	role: "user" | "assistant";
	parts: CliPart[];
	createdAt: string;
}

export interface CliChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** The Claude CLI session id this chat resumes. */
	cliSessionId?: string;
	messages: CliMessage[];
}

export interface CliChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

/** What a turn streams (NDJSON, one object per line). */
export type CliWireEvent =
	| { type: "text"; delta: string }
	| { type: "tool-start"; id: string; name: string; input: unknown }
	| { type: "tool-end"; id: string; output: string; isError: boolean }
	| { type: "approval"; approval: CliApproval }
	| { type: "approval-settled"; id: string; approved: boolean }
	| { type: "usage"; usage: UsageSnapshot }
	| { type: "error"; message: string }
	| { type: "done" };

/** What a destructive tool asks the broker to put in front of the learner. */
export interface CliApprovalRequest {
	tool: string;
	title: string;
	lines: string[];
	edit?: CliApprovalEdit;
}

export type CliApprovalDecision = { approved: false } | { approved: true; edit?: CliApprovalEdit };

/** The five rewritable graph ledgers, captured verbatim. */
export interface LedgerSnapshot {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
	positions: Record<string, Position>;
}

/** The single latest undo point. */
export interface UndoRecord {
	id: string;
	label: string;
	at: string;
	/** graphRevision() right after the change; undo is valid only while it still matches. */
	revisionAfter: number;
	ledgers: LedgerSnapshot;
}

export type CliOpResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

export const DEFAULT_CLI_TITLE = "New CLI chat";
