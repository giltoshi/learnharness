/**
 * Spawns one Claude CLI turn and yields the app's run events. The process
 * boundary is injectable (SpawnProc) so tests drive recorded lines through
 * the real mapper with no CLI installed. Deliberately NOT inheriting
 * ANTHROPIC_API_KEY: with it set the CLI bills the API instead of the
 * learner's subscription, which defeats the plan-limit meter.
 */
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { buildCliArgs, CLI_SYSTEM_PROMPT, MCP_SERVER_NAME } from "./args.ts";
import { createStreamMapper, type CliRunEvent } from "./stream-map.ts";

export interface CliProc {
	lines: AsyncIterable<string>;
	stderr(): string;
	kill(): void;
	exit: Promise<number | null>;
	writeStdin(text: string): void;
}
export type SpawnProc = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => CliProc;

export const spawnProc: SpawnProc = (bin, args, opts) => {
	const child = nodeSpawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
	let err = "";
	child.stderr.on("data", (d: Buffer) => { err += String(d); });
	const exit = new Promise<number | null>((resolve) => {
		child.on("error", (e) => { err += String(e); resolve(-1); });
		child.on("close", (code) => resolve(code));
	});
	return {
		lines: createInterface({ input: child.stdout }),
		stderr: () => err,
		kill: () => { child.kill(); },
		exit,
		writeStdin: (text) => { child.stdin.end(text); },
	};
};

export interface RunCliTurnOptions {
	prompt: string;
	resume?: string;
	mcpUrl: string;
	workDir: string;
	toolNames: string[];
	signal?: AbortSignal;
	bin?: string;
	spawnProc?: SpawnProc;
	tmpRoot?: string;
	now?: () => Date;
}

/**
 * Spike finding (Task 1): on Windows the bare name `claude` cannot be spawned without a
 * shell (ENOENT; `claude.cmd` → EINVAL), and shell:true mangles `--tools ""`. The npm
 * install ships a real binary at <npm-prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe,
 * next to the `claude.cmd` shim that `where` finds. Resolution order: LH_CLAUDE_BIN override →
 * (win32) a `.exe` hit from `where`, or the npm-package exe beside a `.cmd` hit → bare "claude".
 */
export function resolveClaudeBin(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (p: string) => boolean = fs.existsSync,
	where: () => string[] = defaultWhere,
): string {
	if (env.LH_CLAUDE_BIN) return env.LH_CLAUDE_BIN;
	if (platform !== "win32") return "claude";
	for (const found of where()) {
		if (found.toLowerCase().endsWith(".exe")) return found;
		const exe = path.win32.join(path.win32.dirname(found), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
		if (exists(exe)) return exe;
	}
	return "claude";
}

/** Resolved once per process: `where.exe` is a blocking call and the install does not move mid-session. */
let cachedBin: string | undefined;

/** Caches only a real resolution: never the bare fallback, never an LH_CLAUDE_BIN override (read fresh). */
function claudeBin(): string {
	if (cachedBin) return cachedBin;
	const bin = resolveClaudeBin();
	if (bin !== "claude" && !process.env.LH_CLAUDE_BIN) cachedBin = bin;
	return bin;
}

function defaultWhere(): string[] {
	try {
		return execFileSync("where.exe", ["claude"], { encoding: "utf-8" }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

const NOT_FOUND = "Claude CLI not found. Install it from https://claude.com/claude-code, run `claude` once to sign in, then try again.";

export async function* runCliTurn(o: RunCliTurnOptions): AsyncGenerator<CliRunEvent> {
	fs.mkdirSync(o.workDir, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(o.tmpRoot ?? os.tmpdir(), "lh-cli-"));
	let proc: CliProc | undefined;
	let exited = false;
	const onAbort = () => proc?.kill();
	try {
		const mcpConfigPath = path.join(tmp, "mcp.json");
		const systemPromptPath = path.join(tmp, "system.md");
		fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: o.mcpUrl } } }));
		fs.writeFileSync(systemPromptPath, CLI_SYSTEM_PROMPT);

		const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: "600000" };
		delete env.ANTHROPIC_API_KEY;

		proc = (o.spawnProc ?? spawnProc)(o.bin ?? claudeBin(), buildCliArgs({ mcpConfigPath, systemPromptPath, toolNames: o.toolNames, resume: o.resume }), { cwd: o.workDir, env });
		void proc.exit.then(() => { exited = true; }, () => { exited = true; });
		if (o.signal?.aborted) onAbort();
		else o.signal?.addEventListener("abort", onAbort, { once: true });
		proc.writeStdin(o.prompt);

		const mapper = createStreamMapper(o.now);
		let sawError = false;
		for await (const raw of proc.lines) {
			let parsed: unknown;
			try { parsed = JSON.parse(raw); } catch { continue; }
			for (const ev of mapper.push(parsed)) {
				if (ev.type === "error") sawError = true;
				yield ev;
			}
		}
		const code = await proc.exit;
		if (code !== 0 && !sawError && !o.signal?.aborted) {
			const err = proc.stderr();
			yield { type: "error", message: /ENOENT|not recognized|not found/i.test(err) && code === -1 ? NOT_FOUND : `Claude CLI exited with code ${code}: ${err.trim().split("\n").slice(-5).join("\n")}` };
		}
	} finally {
		o.signal?.removeEventListener("abort", onAbort);
		if (proc && !exited) proc.kill();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
