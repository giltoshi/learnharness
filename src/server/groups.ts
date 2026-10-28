import * as ops from "../core/group-ops.ts";
import { GroupError } from "../core/groups.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";

/** Group-operation HTTP outcome: GroupError maps to 4xx, success carries the
 *  new graphRevision (the refetch signal every graph listener follows). */
export interface GroupHttp {
	status: number;
	body: Record<string, unknown>;
}

function respond(run: () => object): GroupHttp {
	try {
		return { status: 200, body: { ...run(), graphRevision: graphRevision() } };
	} catch (err) {
		if (err instanceof GroupError) {
			return { status: err.code === "unknown_group" ? 404 : 400, body: { error: err.message, code: err.code } };
		}
		throw err;
	}
}

export const groupApi = {
	create: (input: { name: string; parentGroupId?: string; sessionIds?: string[] }) => respond(() => ops.createGroupOp(stores, input)),
	rename: (id: string, name: string) => respond(() => ops.renameGroupOp(stores, id, name)),
	setParent: (id: string, parentGroupId: string | null) => respond(() => ops.setGroupParentOp(stores, id, parentGroupId)),
	remove: (id: string) => respond(() => ops.deleteGroupOp(stores, id)),
	moveSessions: (groupId: string | null, sessionIds: string[]) =>
		respond(() => (groupId === null ? ops.removeSessionsOp(stores, sessionIds) : ops.addSessionsOp(stores, groupId, sessionIds))),
};
