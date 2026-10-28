import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { LearnHarnessServer, type ServerSettings } from "./server";
import { LearnHarnessView, VIEW_TYPE } from "./view";

declare const __LH_REPO__: string;

const DEFAULTS: ServerSettings = { repoPath: __LH_REPO__, nodePath: "node", port: 3417 };

export default class LearnHarnessPlugin extends Plugin {
	config: ServerSettings = { ...DEFAULTS };
	server = new LearnHarnessServer(() => this.config);

	override async onload(): Promise<void> {
		this.config = { ...DEFAULTS, ...((await this.loadData()) as Partial<ServerSettings> | null) };
		this.registerView(VIEW_TYPE, (leaf) => new LearnHarnessView(leaf, this.server));
		this.addRibbonIcon("graduation-cap", "Open LearnHarness", () => void this.open());
		this.addCommand({ id: "open", name: "Open", callback: () => void this.open() });
		this.addCommand({ id: "restart-server", name: "Restart server", callback: () => void this.restart() });
		this.addSettingTab(new LearnHarnessSettingTab(this.app, this));
	}

	override onunload(): void { this.server.stop(); }

	async open(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getLeaf("tab");
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Picks up a fresh `npm run build:standalone` or changed settings. */
	async restart(): Promise<void> {
		this.server.stop();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			await leaf.setViewState({ type: "empty" });
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
	}

	async saveSettings(): Promise<void> { await this.saveData(this.config); }
}

class LearnHarnessSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: LearnHarnessPlugin) { super(app, plugin); }

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.config;
		const text = (name: string, desc: string, key: "repoPath" | "nodePath") =>
			new Setting(containerEl).setName(name).setDesc(desc).addText((t) => t.setValue(s[key]).onChange(async (v) => { s[key] = v.trim() || DEFAULTS[key]; await this.plugin.saveSettings(); }));
		text("LearnHarness folder", "The fork checkout. Its data/ and auth.json are used as-is.", "repoPath");
		text("Node executable", "Runs the server. A bare name is looked up on PATH.", "nodePath");
		new Setting(containerEl).setName("Port").setDesc("Preferred localhost port; a free one is used if it's taken.").addText((t) => t.setValue(String(s.port)).onChange(async (v) => {
			const port = Number(v);
			if (Number.isInteger(port) && port > 1023 && port < 65536) { s.port = port; await this.plugin.saveSettings(); }
		}));
		containerEl.createEl("p", { text: "Changes apply after the “LearnHarness: Restart server” command." });
	}
}
