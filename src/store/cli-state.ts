/** CliStateStore — two single-record JSON files: the latest plan-limit snapshot and the latest undo point. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { UndoRecord, UsageSnapshot } from "../core/contracts/cli.ts";
import type { CliStateStore } from "../core/ports.ts";

export function createCliStateStore(dir: string): CliStateStore {
	const usageFile = path.join(dir, "usage.json");
	const undoFile = path.join(dir, "undo.json");
	const readJson = <T>(file: string, valid: (v: Record<string, unknown>) => boolean): T | null => {
		try {
			const v: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
			return valid(v as Record<string, unknown>) ? (v as T) : null;
		} catch { return null; }
	};
	const isObj = (v: unknown): boolean => typeof v === "object" && v !== null;
	const writeJson = (file: string, value: unknown): void => {
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(value), "utf-8");
		fs.renameSync(tmp, file);
	};
	return {
		readUsage: () => readJson<UsageSnapshot>(usageFile, (v) => typeof v.capturedAt === "string"),
		writeUsage: (s) => writeJson(usageFile, s),
		readUndo: () => readJson<UndoRecord>(undoFile, (v) =>
			typeof v.id === "string" && typeof v.label === "string" && typeof v.revisionAfter === "number" && isObj(v.ledgers)),
		writeUndo: (r) => writeJson(undoFile, r),
		clearUndo: () => { try { fs.unlinkSync(undoFile); } catch { /* none */ } },
	};
}
