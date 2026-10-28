import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import http from "http";
import net from "net";
import path from "path";

/**
 * The plugin's stand-in for electron/main.cjs: spawn the fork's standalone
 * Next server on 127.0.0.1 and wait until it answers. Browser-only mode
 * (no LH_DESKTOP_SERVER), so the pane needs no desktop secret header.
 */

export interface ServerSettings {
	repoPath: string;
	nodePath: string;
	port: number;
}

const LOG_LINES = 200;
const START_TIMEOUT_MS = 60_000;

export class LearnHarnessServer {
	private child: ChildProcess | null = null;
	private starting: Promise<string> | null = null;
	private readonly log: string[] = [];

	constructor(private readonly settings: () => ServerSettings) {}

	/** The server's URL, starting it on first call; concurrent callers share one start. */
	start(): Promise<string> {
		this.starting ??= this.launch().catch((error: unknown) => { this.starting = null; throw error; });
		return this.starting;
	}

	stop(): void {
		this.child?.kill();
		this.child = null;
		this.starting = null;
	}

	logTail(lines = 20): string { return this.log.slice(-lines).join("\n"); }

	private record(chunk: Buffer): void {
		for (const line of chunk.toString().split(/\r?\n/)) if (line) this.log.push(line);
		this.log.splice(0, Math.max(0, this.log.length - LOG_LINES));
	}

	private async launch(): Promise<string> {
		const { repoPath, nodePath, port: preferred } = this.settings();
		const entry = path.join(repoPath, ".next", "standalone", "server.js");
		if (!existsSync(entry)) throw new Error(`No server build at ${entry}.\nRun \`npm run build:standalone\` in ${repoPath}, then reopen this pane.`);

		// A fixed port keeps the app's origin, and so its saved UI state, stable across launches.
		const port = (await portFree(preferred)) ? preferred : await freePort();
		const child = spawn(nodePath, [entry], {
			cwd: path.dirname(entry),
			windowsHide: true,
			env: {
				...process.env,
				NODE_ENV: "production",
				PORT: String(port),
				HOSTNAME: "127.0.0.1", // never 0.0.0.0
				// The standalone tree is not the repo: point the data and key seams back at it.
				LH_DATA_DIR: path.join(repoPath, "data"),
				LH_AUTH_FILE: path.join(repoPath, "auth.json"),
			},
		});
		this.child = child;
		child.stdout?.on("data", (b: Buffer) => this.record(b));
		child.stderr?.on("data", (b: Buffer) => this.record(b));
		const exited = new Promise<never>((_, reject) => {
			child.on("error", (e) => reject(new Error(`Could not start \`${nodePath}\`: ${e.message}`)));
			child.on("exit", (code) => { if (this.child === child) { this.child = null; this.starting = null; } reject(new Error(`Server exited (code ${code}).`)); });
		});

		const url = `http://127.0.0.1:${port}`;
		await Promise.race([waitUntilUp(url), exited]);
		return url;
	}
}

function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(false));
		srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
	});
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

/** Next has no ready signal: poll until the server answers anything. */
function waitUntilUp(url: string): Promise<void> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const req = http.get(url, (res) => { res.resume(); resolve(); });
			req.on("error", () => {
				if (Date.now() > deadline) reject(new Error(`Server never answered on ${url}.`));
				else setTimeout(attempt, 250);
			});
		};
		attempt();
	});
}
