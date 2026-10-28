/**
 * CliChatStore — fs JSON adapter (one file per Claude CLI chat). Same idioms
 * as store/chats.ts: sync fs, tab-indented JSON, id-guarded filenames. Writes
 * go through a temp file + rename so a torn write never replaces a record.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CLI_TITLE, type CliChatRecord, type CliChatSummary } from "../core/contracts/cli.ts";
import type { CliChatStore } from "../core/ports.ts";

export function createCliChatStore(dir: string): CliChatStore {
	const fileOf = (id: string): string => {
		if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid CLI chat id: ${id}`);
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
		try {
			const parsed = JSON.parse(fs.readFileSync(fileOf(id), "utf-8")) as CliChatRecord;
			return typeof parsed.id === "string" && Array.isArray(parsed.messages) ? parsed : null;
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("Invalid CLI chat id")) throw err;
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
			const now = new Date().toISOString();
			const record: CliChatRecord = {
				id: `cli_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
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
				const rec = read(name.slice(0, -5));
				if (rec) out.push({ id: rec.id, title: rec.title, createdAt: rec.createdAt, updatedAt: rec.updatedAt, messageCount: rec.messages.length });
			}
			return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		save(id, patch) {
			const rec = need(id);
			const next: CliChatRecord = {
				...rec,
				...(patch.messages ? { messages: patch.messages, updatedAt: new Date().toISOString() } : {}),
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
			try { fs.unlinkSync(fileOf(id)); return true; } catch (err) {
				if (err instanceof Error && err.message.startsWith("Invalid CLI chat id")) throw err;
				return false;
			}
		},
	};
}
