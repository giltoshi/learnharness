import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { LearnHarnessServer } from "./server";

export const VIEW_TYPE = "learnharness";

/** One pane = the LearnHarness app in an Electron <webview> (its own page, so cookies and storage behave like a top-level tab). */
export class LearnHarnessView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private readonly server: LearnHarnessServer) { super(leaf); }

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return "LearnHarness"; }
	override getIcon(): string { return "graduation-cap"; }

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("learnharness-view");
		const status = root.createDiv({ cls: "learnharness-status", text: "Starting LearnHarness…" });
		try {
			const url = await this.server.start();
			status.remove();
			const webview = root.createEl("webview" as keyof HTMLElementTagNameMap);
			webview.setAttribute("src", url);
			webview.setAttribute("partition", "persist:learnharness");
		} catch (error) {
			status.addClass("is-error");
			const tail = this.server.logTail();
			status.setText(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nServer log:\n${tail}` : ""}`);
		}
	}

	override async onClose(): Promise<void> { this.contentEl.empty(); }
}
