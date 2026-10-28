import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { desktopAPIAuthorized } from "../src/server/desktop-access.ts";
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
		try {
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
		} finally { delete process.env.ANTHROPIC_API_KEY; }
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
	it("removes its temp dir after a normal run", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-root-"));
		try {
			const { spawn } = fakeProc([{ type: "system", session_id: "s" }]);
			await collect(runCliTurn({ ...base, spawnProc: spawn, tmpRoot: root }));
			assert.deepEqual(fs.readdirSync(root), []);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
	it("a non-zero exit after an error result adds no second error event", async () => {
		const { spawn } = fakeProc([{ type: "result", is_error: true, result: "bad" }], 1, "boom");
		const events = await collect(runCliTurn({ ...base, spawnProc: spawn }));
		assert.equal(events.filter((e) => e.type === "error").length, 1);
	});
	it("kills the child when the consumer stops early", async () => {
		let killed = false;
		const spawn: SpawnProc = () => ({
			lines: (async function* () { yield JSON.stringify({ type: "system", session_id: "s" }); await new Promise(() => {}); })(),
			stderr: () => "", kill: () => { killed = true; }, exit: new Promise(() => {}), writeStdin: () => {},
		});
		const it2 = runCliTurn({ ...base, spawnProc: spawn });
		await it2.next();
		await it2.return(undefined);
		assert.equal(killed, true);
	});
	it("removes the abort listener even when lines throws", async () => {
		const ac = new AbortController();
		let added = 0, removed = 0;
		const add = ac.signal.addEventListener.bind(ac.signal), rem = ac.signal.removeEventListener.bind(ac.signal);
		ac.signal.addEventListener = ((...a: Parameters<typeof add>) => { added++; return add(...a); }) as typeof add;
		ac.signal.removeEventListener = ((...a: Parameters<typeof rem>) => { removed++; return rem(...a); }) as typeof rem;
		const spawn: SpawnProc = () => ({
			lines: (async function* () { throw new Error("pipe broke"); })(),
			stderr: () => "", kill: () => {}, exit: Promise.resolve(0), writeStdin: () => {},
		});
		await assert.rejects(collect(runCliTurn({ ...base, spawnProc: spawn, signal: ac.signal })), /pipe broke/);
		assert.equal(added, 1);
		assert.equal(removed, 1);
	});
});

describe("runCliTurn desktop auth and env scrub", () => {
	const SECRET = "s".repeat(64);
	const SCRUBBED = ["ANTHROPIC_API_KEY", "LH_DESKTOP_API_SECRET", "LH_DESKTOP_SERVER", "ELECTRON_RUN_AS_NODE", "LH_AUTH_FILE", "LH_DEV_URL"];
	async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
		const saved: Record<string, string | undefined> = {};
		for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
		try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
	}
	it("carries the desktop header in the MCP config when LH_DESKTOP_API_SECRET is set, and the server accepts it", async () => {
		await withEnv({ LH_DESKTOP_API_SECRET: SECRET, LH_DESKTOP_SERVER: "1" }, async () => {
			const { spawn, seen } = fakeProc([]);
			await collect(runCliTurn({ ...base, spawnProc: spawn }));
			const cfg = JSON.parse(seen.cfg);
			assert.deepEqual(cfg.mcpServers.lh, { type: "http", url: base.mcpUrl, headers: { "x-learnharness-desktop": SECRET } });
			assert.equal(desktopAPIAuthorized(new Headers(cfg.mcpServers.lh.headers), { LH_DESKTOP_API_SECRET: SECRET, LH_DESKTOP_SERVER: "1" }), true);
			assert.equal(desktopAPIAuthorized(new Headers(), { LH_DESKTOP_API_SECRET: SECRET, LH_DESKTOP_SERVER: "1" }), false);
		});
	});
	it("has no headers key when the secret is unset", async () => {
		await withEnv({ LH_DESKTOP_API_SECRET: undefined }, async () => {
			const { spawn, seen } = fakeProc([]);
			await collect(runCliTurn({ ...base, spawnProc: spawn }));
			assert.ok(!("headers" in JSON.parse(seen.cfg).mcpServers.lh));
		});
	});
	it("scrubs secrets and desktop-only vars from the child env", async () => {
		const vars: Record<string, string> = {};
		for (const k of SCRUBBED) vars[k] = k === "LH_DESKTOP_API_SECRET" ? SECRET : "x";
		await withEnv(vars, async () => {
			const { spawn, seen } = fakeProc([]);
			await collect(runCliTurn({ ...base, spawnProc: spawn }));
			for (const k of SCRUBBED) assert.equal(seen.env[k], undefined, k);
			assert.equal(seen.env.MCP_TOOL_TIMEOUT, "600000");
		});
	});
});
