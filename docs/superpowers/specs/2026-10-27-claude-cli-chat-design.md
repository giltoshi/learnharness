# Claude CLI chat + subscription usage meter — design

Status: draft for owner review (2026-10-27). Nothing implemented.

## Goal

Let the learner talk to the Claude CLI from inside the app, in a dedicated chat, to manage knowledge-graph nodes and chats (e.g. tidy or collapse all FINA 411 nodes). Add a plan-limit meter showing how much of the Claude subscription (5-hour and weekly windows) has been used.

## Decisions (owner-confirmed)

1. **Form:** a chat UI (existing chat components) driving the CLI headless: `claude -p --output-format stream-json --verbose --resume <sessionId>`. Not an embedded terminal.
2. **Access:** the CLI reaches the app only through an app-run **local MCP server** passed via `--mcp-config`, with `--allowedTools` restricted to the app's tools. Built-in Bash/Edit/Read etc. are disabled. The CLI never touches `data/`.
3. **Approval:** destructive tools (`delete_nodes`, `merge_nodes`, `delete_chats`) pause on an approval card in the chat. Nothing happens until the learner approves; closing the window rejects.
4. **Node editing:** merge is in scope (see Merge). Rename/tag of nodes is not.
5. **Merge intent:** one general tool. The CLI defaults to merging duplicates and keeping structure; it collapses a whole course into one node only when the learner asks.
6. **Merged identity:** the request supplies the new `name` and `statement`; the approval card lets the learner edit them. Old names/statements become aliases.
7. **Safety:** snapshot the affected ledgers before every approved merge/delete; the chat shows an Undo button, valid until the next graph change.
8. **Placement:** a "Claude CLI" sidebar entry opens the CLI chat as its own window; a plan-limit meter sits in the top bar with a popover (5-hour, weekly, reset times).
9. **Meter refresh:** updated from the `rate_limit_event` on each CLI turn only (no background pings). Shows "as of HH:MM" when stale and "no data yet" when empty.
10. **Persistence:** CLI chats are saved, listed in the sidebar, and resume the same CLI session (session id stored on the chat record).

## Verified facts

- `claude` 2.1.312 is installed. A stream-json run emits `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}` with `utilization` (0–1), `resetsAt` (epoch s) and `status`.
- Nodes are minimal propositions (`name`, `statement`, `aliases`, `provenance`); chains link propositions. The extraction pipeline is the sole graph writer; today the only destructive operation is `deleteGraphNode` (409 while an extraction runs). Chats support list, create, `renameChat`, and delete with a mode (`preserve-graph` / `delete-nodes`).
- Architecture law (`docs/architecture.md` §2): core is pure; agent receives dependencies via factories; `app/` imports only the `@/src/core` and `@/src/server` barrels; `components/` imports only `@/src/core`.

## Architecture (by layer)

- **Core:** contracts for a CLI chat record (CLI session id, messages), a `UsageSnapshot` (windows, capturedAt), and the pure `mergeNodes` ledger function (next to `core/graph-deletion.ts`). No IO.
- **Store:** CLI chat persistence; latest-value usage snapshot; ledger snapshots for undo. Fs adapters only.
- **Agent:** CLI runner (spawn, stream-json parser, mapping to chat message/tool parts, usage extraction); MCP tool definitions built by factory from injected ports.
- **Server:** MCP server lifecycle per turn, the approval broker (pending requests, approve/reject/timeout), the turn route, the usage route, undo route. Composition lives here.
- **Shell:** sidebar entry, CLI chat view reusing chat components plus an approval card and Undo button, top-bar meter + popover.

## MCP tools

| Tool | Kind | Behavior |
|---|---|---|
| `list_nodes`, `search_nodes` | read | text search; filter by creating chat |
| `get_node` | read | node, its chains, source chats |
| `list_chats`, `get_chat` | read | title and summary only, not the transcript |
| `rename_chat` | immediate | existing `renameChat` |
| `delete_nodes` | approval | `deleteGraphNode` per id; 409 reported to the CLI (extraction running) |
| `merge_nodes` | approval | see Merge |
| `delete_chats` | approval | `deleteChatSession`; card shows the delete mode |

Tool instructions tell the CLI: default to merging duplicates and preserving structure; collapse only on explicit request; always state chain counts affected.

## Merge

Input: node ids (≥2), new `name`, new `statement`.

- Create the merged node with the supplied identity. Aliases = union of all old names, statements and aliases (deduped). Provenance = union of old provenance.
- Re-point every chain referencing an old node to the merged node; de-duplicate chains by (premises, conclusion), merging their provenance.
- Drop chains that become self-referential (the merged node is both a premise and the conclusion) or empty. A full collapse therefore drops all internal chains.
- Remove old nodes from the positions ledger; re-settle layout.
- Runs as one synchronous block through `rewriteLedgers`, with the same extraction gate as node deletion (409 while any extraction is registered). Pure computation in core; the store only makes the replacement atomic.
- Approval card preview: nodes merged, proposed name/statement (editable), chains rewritten, chains dropped.
- Records a third ledger writer in `docs/architecture.md` (alongside extraction and deletion) and in the one-writer table.

## Undo

Before each approved merge/delete, copy the affected ledgers (nodes, chains, coverage, checkpoints, positions) to a snapshot. Undo restores them atomically and is offered until the next graph change (any extraction merge, deletion, or merge invalidates it). Restoring is also gated on no running extraction.

## Turn flow

1. Learner sends a message; server spawns `claude` with the MCP config and restricted tools, resuming the stored CLI session id.
2. Stream events map to the app's chat message and tool-call parts.
3. `rate_limit_event` is written to the usage snapshot; the meter reads it.
4. Session id is saved on the chat record.

## Errors

- `claude` missing or not logged in: setup message in the chat, no crash.
- Spawn failure or non-zero exit: error row in the chat.
- Tool failures return to the CLI as normal tool errors so it can explain them.
- Approval for a request whose chat window closed: rejected. Approval after the graph changed underneath (node gone): the tool reports it and nothing is written.

## Testing

Deterministic, no network; the CLI is replaced by a fake emitting recorded stream-json. Cover: stream→message mapper; usage snapshot parsing and stale/empty meter states; each MCP tool against in-memory stores; approval flow (approve, reject, window closed); extraction 409 path; `mergeNodes` (alias/provenance union, chain re-pointing and dedupe, dropped self-chains, positions pruning); snapshot + undo, including invalidation by a later graph change. Lint (import law) and typecheck stay green. One manual check against the real `claude`.

## Out of scope (v1)

Node rename/tag; background usage pings; embedded terminal; CLI access to full chat transcripts; non-Claude CLIs.

## Spike results

Run 2026-10-27 against `claude` 2.1.312 on Windows 11 / Node 24.18 (fixture: `tests/fixtures/cli/tool-run.jsonl`).

- **MCP http server accepted: yes.** The CLI posts `server/discover`, `initialize`, `notifications/initialized` (202), `tools/list`, then `tools/call` to a plain JSON-response `http` endpoint; the `system/init` line reports `"mcp_servers":[{"name":"lh","status":"connected","source":"dynamic"}]`.
- **90 s tool call survived: yes.** With `MCP_TOOL_TIMEOUT=600000` a `tools/call` held for 90 000 ms returned `pong`, the run exited 0 (total about 110 s wall-clock).
- **Spawn without shell: NO for the bare name.** `spawn("claude", …)` fails with `ENOENT` and `spawn("claude.cmd", …)` fails with `EINVAL` (Node refuses `.cmd` without a shell); the npm shim is only `claude`/`claude.cmd`/`claude.ps1`. The real binary `…\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` spawns fine without a shell (`--version` printed 2.1.312). `shell: true` also works but concatenates unescaped args (and would mangle an empty `--tools ""`), so the runner should resolve the `.exe` path (or take it from config) instead.
- **tool_use shape:** an `assistant` line has `message.content[]` containing `{"type":"tool_use","id":"toolu_…","name":"mcp__lh__ping_lh","input":{},"caller":{"type":"direct"}}`.
- **tool_result shape:** a `user` line has `message.content[]` containing `{"tool_use_id":"toolu_…","type":"tool_result","content":[{"type":"text","text":"pong"}]}` (content is an array of text blocks, not a string), plus top-level `tool_use_result` and `tool_result_meta`; there is no `is_error` key on success.
- Also seen: 2 `assistant` lines (tool_use turn, then final text turn), 1 `user` tool_result line, a `rate_limit_event` line, and a final `result` line with `total_cost_usd` and `usage`.
