/** CliStateStore — two single-record JSON files: the latest plan-limit snapshot and the latest undo point. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { UndoRecord, UsageSnapshot } from "../core/contracts/cli.ts";
import type { CliStateStore } from "../core/ports.ts";

export function createCliStateStore(dir: string): CliStateStore {
	const usageFile = path.join(dir, "usage.json");
	const undoFile = path.join(dir, "undo.json");
	const readJson = <T>(file: string): T | null => {
		try { return JSON.parse(fs.readFileSync(file, "utf-8")) as T; } catch { return null; }
	};
	const writeJson = (file: string, value: unknown): void => {
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(value), "utf-8");
		fs.renameSync(tmp, file);
	};
	return {
		readUsage: () => readJson<UsageSnapshot>(usageFile),
		writeUsage: (s) => writeJson(usageFile, s),
		readUndo: () => readJson<UndoRecord>(undoFile),
		writeUndo: (r) => writeJson(undoFile, r),
		clearUndo: () => { try { fs.unlinkSync(undoFile); } catch { /* none */ } },
	};
}
