import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleMcpMessage, type CliTool } from "../src/agent/cli/mcp-rpc.ts";

const tools: CliTool[] = [
	{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { s: { type: "string" } } }, run: async (a) => ({ text: `got ${String(a.s)}` }) },
	{ name: "boom", description: "Fails", inputSchema: { type: "object" }, run: async () => { throw new Error("kaboom"); } },
	{ name: "soft", description: "Soft fail", inputSchema: { type: "object" }, run: async () => ({ text: "refused", isError: true }) },
];
const call = (method: string, params?: unknown, id: number | undefined = 1) => handleMcpMessage({ jsonrpc: "2.0", id, method, params }, tools);

describe("handleMcpMessage", () => {
	it("initialize echoes the client's protocol version and advertises tools", async () => {
		const r = await call("initialize", { protocolVersion: "2025-06-18" });
		assert.deepEqual(r, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "learnharness", version: "1" } } });
	});
	it("notifications (no id) return null", async () => {
		assert.equal(await call("notifications/initialized", undefined, undefined), null);
	});
	it("tools/list returns name, description, inputSchema", async () => {
		const r = (await call("tools/list")) as { result: { tools: Array<{ name: string }> } };
		assert.deepEqual(r.result.tools.map((t) => t.name), ["echo", "boom", "soft"]);
		assert.ok("inputSchema" in r.result.tools[0]!);
	});
	it("tools/call runs the tool and wraps text content", async () => {
		const r = await call("tools/call", { name: "echo", arguments: { s: "hi" } });
		assert.deepEqual(r, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "got hi" }] } });
	});
	it("a thrown tool error and a soft failure are isError results, not RPC errors", async () => {
		const thrown = (await call("tools/call", { name: "boom", arguments: {} })) as { result: { isError: boolean; content: Array<{ text: string }> } };
		assert.equal(thrown.result.isError, true);
		assert.match(thrown.result.content[0]!.text, /kaboom/);
		const soft = (await call("tools/call", { name: "soft", arguments: {} })) as { result: { isError: boolean } };
		assert.equal(soft.result.isError, true);
	});
	it("unknown tool is an isError result; unknown method is -32601; ping is {}", async () => {
		const unk = (await call("tools/call", { name: "nope" })) as { result: { isError: boolean } };
		assert.equal(unk.result.isError, true);
		assert.deepEqual((await call("bogus")) as object, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found: bogus" } });
		assert.deepEqual(await call("ping"), { jsonrpc: "2.0", id: 1, result: {} });
	});
	it("the CLI's extra server/discover request gets the tolerated -32601", async () => {
		assert.deepEqual(await call("server/discover"), { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found: server/discover" } });
	});
	it("a non-object or batch body is -32600", async () => {
		const r = (await handleMcpMessage([{}], tools)) as { error: { code: number } };
		assert.equal(r.error.code, -32600);
	});
});
