import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupsPanel } from "../components/groups-panel.tsx";

const render = (collapsed: string[] = []) =>
	renderToStaticMarkup(
		createElement(GroupsPanel, {
			groups: [{ id: "g1", name: "FINA 411" }, { id: "g2", name: "Risk", parentGroupId: "g1" }],
			sessionGroups: { s1: "g2" },
			sessionLabels: { s1: "Ch 05.md", s2: "Loose chat" },
			collapsed: new Set(collapsed),
			onToggleCollapse: () => {},
			onClose: () => {},
		}),
	);

describe("GroupsPanel", () => {
	it("lists nested groups, their sessions and ungrouped sessions", () => {
		const html = render();
		assert.match(html, /FINA 411/);
		assert.match(html, /Risk/);
		assert.match(html, /Ch 05\.md/);
		assert.match(html, /Ungrouped/);
		assert.match(html, /Loose chat/);
	});
	it("hides a collapsed group's contents and marks its toggle pressed", () => {
		const html = render(["g1"]);
		assert.doesNotMatch(html, /Ch 05\.md/);
		assert.match(html, /aria-pressed="true"/);
	});
});
