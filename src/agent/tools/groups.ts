import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import * as ops from "../../core/group-ops.ts";
import { GroupError } from "../../core/groups.ts";
import type { GraphToolContext } from "./graph.ts";

/**
 * THE TEACHER'S GROUP TOOLS (2026-10-27): the learner can say "group my
 * FINA 411 chapters" and the teacher organizes the knowledge map. A group
 * holds SESSIONS (ids from list_sessions); moving sessions never touches a
 * node or chain. Registered on the teacher only, behind the SAME
 * graphToolsEnabled gate as the prober's map readers.
 *
 * delete_group is a code-enforced two-step: the first call (no token)
 * writes nothing and returns a preview + one-time token; only a second
 * call carrying that token deletes. The agent can only get a token by
 * previewing, which is the prompt to ask the learner.
 */

const CONFIRM_TTL_MS = 10 * 60 * 1000;
/** Module-level on purpose: the preview and the confirming call land in
 *  different turns, so different tool-registry instances. */
const pendingDeletes = new Map<string, { groupId: string; expires: number }>();

/** Tool answers speak in their own voice: a GroupError is an answer, never a throw. */
async function answer(run: () => string): Promise<string> {
	try {
		return run();
	} catch (err) {
		if (err instanceof GroupError) return err.message;
		throw err;
	}
}

const sessionIds = Type.Array(Type.String({ minLength: 1 }), {
	minItems: 1,
	description: "Session ids exactly as list_sessions reports them (chat ids or src_… notes ids).",
});

export function groupTools(ctx: GraphToolContext): Record<string, AgentTool<any>> {
	const deps = { chatStore: ctx.chatStore, graphStore: ctx.graphStore };

	const createInput = Type.Object({
		name: Type.String({ minLength: 1, description: "The group's name, e.g. 'FINA 411'." }),
		parentGroupId: Type.Optional(Type.String({ description: "Nest the new group under this group id." })),
		sessionIds: Type.Optional(sessionIds),
	});
	const addInput = Type.Object({ groupId: Type.String({ minLength: 1 }), sessionIds });
	const removeInput = Type.Object({ sessionIds });
	const renameInput = Type.Object({ groupId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) });
	const deleteInput = Type.Object({
		groupId: Type.String({ minLength: 1 }),
		confirmToken: Type.Optional(
			Type.String({ description: "The token a previous delete_group call returned, ONLY after the learner confirmed." }),
		),
	});
	const listInput = Type.Object({});

	return {
		create_group: {
			name: "create_group",
			label: "create_group",
			description:
				"Create a named group on the learner's knowledge map, optionally nested under another group and optionally filled with sessions. " +
				"A group holds whole sessions (chats / imported notes files) — e.g. all the chapters of one course. Returns the new group's id and counts.",
			parameters: createInput,
			execute: serverExecute("create_group", createInput, async (input): Promise<string> =>
				answer(() => ops.createGroupOp(deps, input).message)),
		},
		add_sessions_to_group: {
			name: "add_sessions_to_group",
			label: "add_sessions_to_group",
			description:
				"Move sessions into a group, including sessions already in another group (they leave it). Chains and nodes are never changed. Returns counts.",
			parameters: addInput,
			execute: serverExecute("add_sessions_to_group", addInput, async ({ groupId, sessionIds }): Promise<string> =>
				answer(() => ops.addSessionsOp(deps, groupId, sessionIds).message)),
		},
		remove_sessions_from_group: {
			name: "remove_sessions_from_group",
			label: "remove_sessions_from_group",
			description: "Take sessions out of whatever group they are in (they become ungrouped). Chains and nodes are never changed.",
			parameters: removeInput,
			execute: serverExecute("remove_sessions_from_group", removeInput, async ({ sessionIds }): Promise<string> =>
				answer(() => ops.removeSessionsOp(deps, sessionIds).message)),
		},
		rename_group: {
			name: "rename_group",
			label: "rename_group",
			description: "Rename a group.",
			parameters: renameInput,
			execute: serverExecute("rename_group", renameInput, async ({ groupId, name }): Promise<string> =>
				answer(() => ops.renameGroupOp(deps, groupId, name).message)),
		},
		delete_group: {
			name: "delete_group",
			label: "delete_group",
			description:
				"Delete a group — a TWO-STEP action. Call it first WITHOUT confirmToken: nothing is deleted, you get a preview and a one-time token. " +
				"Tell the learner what will happen and ask them to confirm; only if they say yes, call again with the same groupId and that confirmToken. " +
				"Deleting never touches nodes or chains; subgroups and held sessions move up to the group's parent (or become ungrouped).",
			parameters: deleteInput,
			execute: serverExecute("delete_group", deleteInput, async ({ groupId, confirmToken }): Promise<string> =>
				answer(() => {
					if (confirmToken === undefined) {
						const preview = ops.previewDeleteGroupOp(deps, groupId);
						const token = globalThis.crypto.randomUUID().slice(0, 8);
						pendingDeletes.set(token, { groupId, expires: Date.now() + CONFIRM_TTL_MS });
						return (
							`${preview.message} Nothing has been deleted yet. Ask the learner to confirm; if they say yes, ` +
							`call delete_group again with groupId "${groupId}" and confirmToken "${token}".`
						);
					}
					const pending = pendingDeletes.get(confirmToken);
					if (!pending || pending.groupId !== groupId || pending.expires < Date.now()) {
						return "That confirmation is invalid or expired — call delete_group without a token to get a fresh preview.";
					}
					pendingDeletes.delete(confirmToken);
					return ops.deleteGroupOp(deps, groupId).message;
				})),
		},
		list_groups: {
			name: "list_groups",
			label: "list_groups",
			description:
				"List the knowledge map's groups. Each line: id | name (with its parent path) | session count | node count (subgroups included).",
			parameters: listInput,
			execute: serverExecute("list_groups", listInput, async (): Promise<string> => {
				const groups = ops.listGroupsOp(deps);
				if (groups.length === 0) return "There are no groups yet.";
				return groups
					.map((g) => `${g.id} | ${g.path} | ${g.sessions} session${g.sessions === 1 ? "" : "s"} | ${g.nodes} node${g.nodes === 1 ? "" : "s"}`)
					.join("\n");
			}),
		},
	};
}
