import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { buildCliArgs } from "../src/agent/cli/args.ts";
import { resolveClaudeBin, runCliTurn, type CliProc, type SpawnProc } from "../src/agent/cli/runner.ts";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const x of it) out.push(x); return out; }

function fakeProc(lines: unknown[], exitCode = 0, stderr = ""): { spawn: SpawnProc; seen: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; stdin: string; cfg: string; killed: boolean } } {
	const seen = { args: [] as string[], env: {} as NodeJS.ProcessEnv, cwd: "", stdin: "", cfg: "", killed: false };
	const spawn: SpawnProc = (_bin, args, opts) => {
		seen.args = args; seen.env = opts.env; seen.cwd = opts.cwd;
		seen.cfg = fs.readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf-8");
		const proc: CliProc = {
			lines: (async function* () { for (const l of lines) yield typeof l === "string" ? l : JSON.stringify(l); })(),
			stderr: () => stderr, kill: () => { seen.killed = true; }, exit: Promise.resolve(exitCode), writeStdin: (t) => { seen.stdin += t; },
		};
		return proc;
	};
	return { spawn, seen };
}
// `bin` is pinned so the fake-spawn tests never shell out to where.exe.
const base = { prompt: "merge my nodes", mcpUrl: "http://127.0.0.1:3000/api/cli/mcp/tok", workDir: "/tmp/lh-work", toolNames: ["list_nodes", "merge_nodes"], bin: "claude" };

describe("buildCliArgs", () => {
	it("is hardened, joins allowed tools into ONE comma value, and resumes only when asked", () => {
		const a = buildCliArgs({ mcpConfigPath: "m.json", systemPromptPath: "s.md", toolNames: ["list_nodes", "merge_nodes"] });
		assert.deepEqual(a.slice(0, 5), ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
		assert.ok(a.includes("--strict-mcp-config") && a.includes("--disable-slash-commands"));
		assert.equal(a[a.indexOf("--tools") + 1], "");
		assert.equal(a[a.indexOf("--setting-sources") + 1], "");
		assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__lh__list_nodes,mcp__lh__merge_nodes");
		assert.ok(!a.includes("--resume"));
		assert.deepEqual(buildCliArgs({ mcpConfigPath: "m.json", systemPromptPath: "s.md", toolNames: [], resume: "sess" }).slice(-2), ["--resume", "sess"]);
	});
});

describe("resolveClaudeBin", () => {
	const none = () => [] as string[];
	it("LH_CLAUDE_BIN wins everywhere", () => {
		assert.equal(resolveClaudeBin({ LH_CLAUDE_BIN: "/x/claude" }, "win32", () => false, none), "/x/claude");
	});
	it("non-windows uses the bare name", () => {
		assert.equal(resolveClaudeBin({}, "darwin", () => false, none), "claude");
	});
	it("windows: a .exe hit from where is used as-is", () => {
		assert.equal(resolveClaudeBin({}, "win32", () => false, () => ["C:\\bin\\claude.exe"]), "C:\\bin\\claude.exe");
	});
	it("windows: a .cmd shim resolves to the npm package's claude.exe when it exists", () => {
		const shim = "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd";
		const exe = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
		assert.equal(resolveClaudeBin({}, "win32", (p) => p.toLowerCase() === exe.toLowerCase() || p === exe, () => [shim]), exe);
	});
	it("windows: nothing found falls back to the bare name", () => {
		assert.equal(resolveClaudeBin({}, "win32", () => false, () => ["C:\\npm\\claude.cmd"]), "claude");
	});
});

describe("runCliTurn", () => {
	it("writes the MCP config, pipes the prompt on stdin, strips ANTHROPIC_API_KEY, sets the tool timeout, maps events", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
		const { spawn, seen } = fakeProc([
			{ type: "system", subtype: "init", session_id: "s1" },
			{ type: "assistant", message: { id: "m", content: [{ type: "text", text: "done" }] } },
			{ type: "result", is_error: false, result: "done" },
		]);
		const events = await collect(runCliTurn({ ...base, spawnProc: spawn }));
		assert.deepEqual(events, [{ type: "session", id: "s1" }, { type: "text", delta: "done" }]);
		assert.equal(seen.stdin, "merge my nodes");
		assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(seen.env.MCP_TOOL_TIMEOUT, "600000");
		assert.equal(seen.cwd, "/tmp/lh-work");
		assert.deepEqual(JSON.parse(seen.cfg), { mcpServers: { lh: { type: "http", url: base.mcpUrl } } });
		delete process.env.ANTHROPIC_API_KEY;
	});
	it("passes --resume when given a session id", async () => {
		const { spawn, seen } = fakeProc([]);
		await collect(runCliTurn({ ...base, resume: "old-sess", spawnProc: spawn }));
		assert.equal(seen.args[seen.args.indexOf("--resume") + 1], "old-sess");
	});
	it("skips non-JSON lines", async () => {
		const { spawn } = fakeProc(["not json", { type: "assistant", message: { id: "m", content: [{ type: "text", text: "ok" }] } }]);
		assert.deepEqual(await collect(runCliTurn({ ...base, spawnProc: spawn })), [{ type: "text", delta: "ok" }]);
	});
	it("a non-zero exit with no error result becomes an error event carrying the stderr tail", async () => {
		const { spawn } = fakeProc([], 1, "boom\n");
		const events = await collect(runCliTurn({ ...base, spawnProc: spawn }));
		assert.equal(events.length, 1);
		assert.equal(events[0]!.type, "error");
		assert.match((events[0] as { message: string }).message, /exited with code 1.*boom/s);
	});
	it("a missing binary becomes the setup message", async () => {
		const { spawn } = fakeProc([], -1, "Error: spawn claude ENOENT");
		const events = await collect(runCliTurn({ ...base, spawnProc: spawn }));
		assert.match((events[0] as { message: string }).message, /Claude CLI not found/);
	});
	it("kills the child when the signal aborts", async () => {
		const { spawn, seen } = fakeProc([{ type: "system", session_id: "s" }]);
		const ac = new AbortController();
		ac.abort();
		await collect(runCliTurn({ ...base, spawnProc: spawn, signal: ac.signal }));
		assert.equal(seen.killed, true);
	});
});
