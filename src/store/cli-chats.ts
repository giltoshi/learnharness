/**
 * CliChatStore — fs JSON adapter (one file per Claude CLI chat). Same idioms
 * as store/chats.ts: sync fs, tab-indented JSON, id-guarded filenames. Writes
 * go through a temp file + rename so a torn write never replaces a record.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CLI_TITLE, type CliChatRecord, type CliChatSummary } from "../core/contracts/cli.ts";
import type { CliChatStore } from "../core/ports.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;

export class InvalidCliChatIdError extends Error {
	constructor(id: string) {
		super(`Invalid CLI chat id: ${id}`);
		this.name = "InvalidCliChatIdError";
	}
}

function assertId(id: string): void {
	if (!ID_RE.test(id)) throw new InvalidCliChatIdError(id);
}

export function createCliChatStore(dir: string, clock: () => Date = () => new Date()): CliChatStore {
	const fileOf = (id: string): string => {
		assertId(id);
		return path.join(dir, `${id}.json`);
	};
	const write = (record: CliChatRecord): void => {
		fs.mkdirSync(dir, { recursive: true });
		const file = fileOf(record.id);
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(record, null, "\t"), "utf-8");
		fs.renameSync(tmp, file);
	};
	const read = (id: string): CliChatRecord | null => {
		const file = fileOf(id); // throws InvalidCliChatIdError before any fs access
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as CliChatRecord;
			return typeof parsed.id === "string" && Array.isArray(parsed.messages) ? parsed : null;
		} catch {
			return null;
		}
	};
	const need = (id: string): CliChatRecord => {
		const rec = read(id);
		if (rec === null) throw new Error(`Unknown CLI chat: ${id}`);
		return rec;
	};
	return {
		create(title) {
			const now = clock().toISOString();
			const record: CliChatRecord = {
				id: `cli_${clock().getTime().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
				title: title?.trim() || DEFAULT_CLI_TITLE,
				createdAt: now,
				updatedAt: now,
				messages: [],
			};
			write(record);
			return record;
		},
		get: read,
		list() {
			let names: string[];
			try { names = fs.readdirSync(dir); } catch { return []; }
			const out: CliChatSummary[] = [];
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const stem = name.slice(0, -5);
				if (!ID_RE.test(stem)) continue;
				const rec = read(stem);
				if (rec) out.push({ id: rec.id, title: rec.title, createdAt: rec.createdAt, updatedAt: rec.updatedAt, messageCount: rec.messages.length });
			}
			return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		save(id, patch) {
			const rec = need(id);
			const next: CliChatRecord = {
				...rec,
				...(patch.messages ? { messages: patch.messages, updatedAt: clock().toISOString() } : {}),
				...(patch.cliSessionId ? { cliSessionId: patch.cliSessionId } : {}),
			};
			write(next);
			return next;
		},
		rename(id, title) {
			const trimmed = title.trim();
			if (trimmed === "") throw new Error("title must be non-empty");
			const next = { ...need(id), title: trimmed }; // a rename is not activity: updatedAt stays
			write(next);
			return next;
		},
		delete(id) {
			const file = fileOf(id);
			try { fs.unlinkSync(file); return true; } catch { return false; }
		},
	};
}
