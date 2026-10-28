/**
 * A minimal MCP server over JSON-RPC (Streamable HTTP, single-response
 * mode): initialize, ping, tools/list, tools/call. Hand-rolled on purpose —
 * four methods do not justify a dependency in the desktop bundle. Tool
 * failures are `isError` RESULTS (the model can read and explain them), never
 * JSON-RPC errors.
 */
export interface CliToolResult { text: string; isError?: boolean }
export interface CliTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run(args: Record<string, unknown>): Promise<CliToolResult>;
}

type Reply = Record<string, unknown>;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function handleMcpMessage(msg: unknown, tools: CliTool[]): Promise<Reply | null> {
	if (!isRecord(msg) || typeof msg.method !== "string") {
		return { jsonrpc: "2.0", id: isRecord(msg) && "id" in msg ? msg.id : null, error: { code: -32600, message: "Invalid Request" } };
	}
	// Notifications never get a reply: no id, or a `notifications/*` method.
	if (!("id" in msg) || msg.id === undefined || msg.method.startsWith("notifications/")) return null;
	const id = msg.id;
	const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
	const params = isRecord(msg.params) ? msg.params : {};

	switch (msg.method) {
		case "initialize":
			return ok({
				protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "learnharness", version: "1" },
			});
		case "ping":
			return ok({});
		case "tools/list":
			return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
		case "tools/call": {
			const tool = tools.find((t) => t.name === params.name);
			if (!tool) return ok({ isError: true, content: [{ type: "text", text: `Unknown tool: ${String(params.name)}` }] });
			try {
				const r = await tool.run(isRecord(params.arguments) ? params.arguments : {});
				return ok({ ...(r.isError ? { isError: true } : {}), content: [{ type: "text", text: r.text }] });
			} catch (err) {
				return ok({ isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] });
			}
		}
		default:
			return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } };
	}
}
