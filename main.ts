import {
    App,
    ItemView,
    Notice,
    Plugin,
    Setting,
    TFile,
    TextComponent,
    ToggleComponent,
    WorkspaceLeaf
} from "obsidian";
import {
    loadJobConfigFromNote,
    normalizeFolderInput,
    runBatchJob,
    saveJobConfigToNote,
    scanBatchJob
} from "./generator";
import { ImageBatchNoteGeneratorSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type BatchJobConfig, type PluginSettings, type RunReport, type ScanReport } from "./types";

export const VIEW_TYPE_BATCH_NOTE_GENERATOR = "image-metadata-note-generator-view";

class ImageMetadataNoteGeneratorView extends ItemView {
    private state: BatchJobConfig;
    private statusEl: HTMLDivElement | null = null;
    private logEl: HTMLTextAreaElement | null = null;
    private activeJobEl: HTMLDivElement | null = null;
    private inputFolderText: TextComponent | null = null;
    private outputFolderText: TextComponent | null = null;
    private tagsFolderText: TextComponent | null = null;
    private overwriteToggle: ToggleComponent | null = null;
    private deleteExtraToggle: ToggleComponent | null = null;
    private dryRunToggle: ToggleComponent | null = null;
    private isBusy = false;

    constructor(leaf: WorkspaceLeaf, private plugin: ImageBatchNoteGeneratorPlugin) {
        super(leaf);
        this.state = plugin.createDefaultJobConfig();
    }

    getViewType() {
        return VIEW_TYPE_BATCH_NOTE_GENERATOR;
    }

    getDisplayText() {
        return "Image Metadata Note Generator";
    }

    getIcon() {
        return "files";
    }

    async onOpen() {
        this.render();
    }

    async refreshFromCurrentNote() {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
            this.setStatus("Current file is not a Markdown note.");
            return;
        }

        const loaded = loadJobConfigFromNote(this.app, file);
        if (!loaded) {
            this.setStatus(`No batch job frontmatter found in ${file.path}.`);
            return;
        }

        this.state = {
            ...this.state,
            ...loaded
        };
        this.syncControls();
        this.setStatus(`Loaded job from ${file.path}`);
        this.renderActiveJob(file);
    }

    async saveToCurrentNote() {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
            new Notice("Open a Markdown note to save the image metadata job.");
            return;
        }

        await saveJobConfigToNote(this.app.fileManager, file, this.state);
        this.renderActiveJob(file);
        this.setStatus(`Saved image metadata job to ${file.path}`);
        new Notice("Image metadata job saved to current note.");
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("imgbatch-view");

        contentEl.createEl("h2", { text: "Image Metadata Note Generator" });
        contentEl.createEl("p", {
            text: "Use vault-relative folders and optionally load or save the job definition from the current Markdown note."
        });

        const currentFile = this.app.workspace.getActiveFile();
        this.activeJobEl = contentEl.createDiv({ cls: "imgbatch-active-note" });
        this.renderActiveJob(currentFile instanceof TFile ? currentFile : null);

        new Setting(contentEl)
            .setName("Input folder")
            .setDesc("Source image folder inside the vault.")
            .addText((text) => {
                this.inputFolderText = text;
                text.setPlaceholder("Assets/Images");
                text.setValue(this.state.inputFolder);
                text.onChange((value) => {
                    this.state.inputFolder = normalizeFolderInput(value);
                });
            });

        new Setting(contentEl)
            .setName("Output folder")
            .setDesc("Destination folder for generated Markdown notes.")
            .addText((text) => {
                this.outputFolderText = text;
                text.setPlaceholder("Notes/Image Metadata");
                text.setValue(this.state.outputFolder);
                text.onChange((value) => {
                    this.state.outputFolder = normalizeFolderInput(value);
                });
            });

        new Setting(contentEl)
            .setName("Tags folder")
            .setDesc("Folder containing existing tag notes for longest-match splitting.")
            .addText((text) => {
                this.tagsFolderText = text;
                text.setPlaceholder("Tags");
                text.setValue(this.state.tagsFolder);
                text.onChange((value) => {
                    this.state.tagsFolder = normalizeFolderInput(value);
                });
            });

        new Setting(contentEl)
            .setName("Overwrite existing")
            .addToggle((toggle) => {
                this.overwriteToggle = toggle;
                toggle.setValue(this.state.overwriteExisting);
                toggle.onChange((value) => {
                    this.state.overwriteExisting = value;
                });
            });

        new Setting(contentEl)
            .setName("Delete extra notes")
            .setDesc("Delete Markdown files under the output folder that are not produced by the current run.")
            .addToggle((toggle) => {
                this.deleteExtraToggle = toggle;
                toggle.setValue(this.state.deleteExtraNotes);
                toggle.onChange((value) => {
                    this.state.deleteExtraNotes = value;
                });
            });

        new Setting(contentEl)
            .setName("Dry run")
            .setDesc("Compute changes without writing files.")
            .addToggle((toggle) => {
                this.dryRunToggle = toggle;
                toggle.setValue(this.state.dryRun);
                toggle.onChange((value) => {
                    this.state.dryRun = value;
                });
            });

        const actions = contentEl.createDiv({ cls: "imgbatch-actions" });
        this.createButton(actions, "Load current note", async () => {
            await this.refreshFromCurrentNote();
        });
        this.createButton(actions, "Save to current note", async () => {
            await this.saveToCurrentNote();
        });
        this.createButton(actions, "Reset to defaults", async () => {
            this.state = this.plugin.createDefaultJobConfig();
            this.syncControls();
            this.setStatus("Restored defaults.");
        });
        this.createButton(actions, "Scan", async () => {
            await this.handleScan();
        });
        this.createButton(actions, "Run", async () => {
            await this.handleRun();
        });

        this.statusEl = contentEl.createDiv({ cls: "imgbatch-status" });
        this.setStatus("Ready.");

        contentEl.createEl("h3", { text: "Log" });
        this.logEl = contentEl.createEl("textarea", { cls: "imgbatch-log" });
        this.logEl.readOnly = true;
        this.logEl.value = "";
    }

    private renderActiveJob(file: TFile | null) {
        if (!this.activeJobEl) return;
        this.activeJobEl.empty();
        const label = this.activeJobEl.createDiv({ cls: "imgbatch-active-note-label" });
        label.setText("Current note");
        const value = this.activeJobEl.createDiv({ cls: "imgbatch-active-note-value" });
        value.setText(file?.path ?? "None");
    }

    private createButton(container: HTMLElement, text: string, handler: () => Promise<void>) {
        const button = container.createEl("button", { text });
        button.addEventListener("click", async () => {
            if (this.isBusy) return;
            await handler();
        });
    }

    private syncControls() {
        this.inputFolderText?.setValue(this.state.inputFolder);
        this.outputFolderText?.setValue(this.state.outputFolder);
        this.tagsFolderText?.setValue(this.state.tagsFolder);
        this.overwriteToggle?.setValue(this.state.overwriteExisting);
        this.deleteExtraToggle?.setValue(this.state.deleteExtraNotes);
        this.dryRunToggle?.setValue(this.state.dryRun);
    }

    private validateState(): string | null {
        if (!this.state.inputFolder) return "Input folder is required.";
        if (!this.state.outputFolder) return "Output folder is required.";
        if (this.state.inputFolder === this.state.outputFolder) return "Input and output folders must be different.";
        return null;
    }

    private async handleScan() {
        const error = this.validateState();
        if (error) {
            this.setStatus(error);
            new Notice(error);
            return;
        }

        await this.withBusy(async () => {
            this.clearLog();
            this.appendLog(`scan input=${this.state.inputFolder}`);
            const report = await scanBatchJob(this.app, this.state);
            this.renderScanReport(report);
        });
    }

    private async handleRun() {
        const error = this.validateState();
        if (error) {
            this.setStatus(error);
            new Notice(error);
            return;
        }

        await this.withBusy(async () => {
            this.clearLog();
            this.appendLog(`run input=${this.state.inputFolder}`);
            const report = await runBatchJob(this.app, this.state, (line) => this.appendLog(line));
            this.renderRunReport(report);
            if (report.failed.length > 0) {
                new Notice(`Run completed with ${report.failed.length} failures.`);
            } else {
                new Notice(this.state.dryRun ? "Dry run completed." : "Image metadata note generation completed.");
            }
        });
    }

    private async withBusy(work: () => Promise<void>) {
        this.isBusy = true;
        try {
            await work();
        } finally {
            this.isBusy = false;
        }
    }

    private renderScanReport(report: ScanReport) {
        const lines = [
            `Images found: ${report.imageCount}`,
            `Images with metadata: ${report.imagesWithMetadata}`,
            `Images without metadata: ${report.imagesWithoutMetadata.length}`,
            `Existing output notes: ${report.existingOutputCount}`
        ];
        this.setStatus(lines.join(" | "));
        for (const line of lines) {
            this.appendLog(line);
        }
        if (report.imagesWithoutMetadata.length > 0) {
            this.appendLog("Missing metadata:");
            for (const path of report.imagesWithoutMetadata.slice(0, 50)) {
                this.appendLog(`- ${path}`);
            }
        }
    }

    private renderRunReport(report: RunReport) {
        const lines = [
            `Scanned: ${report.scanned}`,
            `Created: ${report.created}`,
            `Updated: ${report.updated}`,
            `Skipped: ${report.skipped}`,
            `Deleted: ${report.deleted}`,
            `Failed: ${report.failed.length}`
        ];
        this.setStatus(lines.join(" | "));
        for (const line of lines) {
            this.appendLog(line);
        }
        if (report.failed.length > 0) {
            this.appendLog("Failures:");
            for (const item of report.failed) {
                this.appendLog(`- ${item}`);
            }
        }
    }

    private setStatus(text: string) {
        if (this.statusEl) {
            this.statusEl.setText(text);
        }
    }

    private appendLog(text: string) {
        if (!this.logEl) return;
        this.logEl.value += `${text}\n`;
        this.logEl.scrollTop = this.logEl.scrollHeight;
    }

    private clearLog() {
        if (this.logEl) {
            this.logEl.value = "";
        }
    }
}

export default class ImageBatchNoteGeneratorPlugin extends Plugin {
    settings: PluginSettings = { ...DEFAULT_SETTINGS };

    async onload() {
        await this.loadSettings();

        this.registerView(
            VIEW_TYPE_BATCH_NOTE_GENERATOR,
            (leaf) => new ImageMetadataNoteGeneratorView(leaf, this)
        );

        this.addRibbonIcon("files", "Open image metadata note generator", async () => {
            await this.activateView();
        });

        this.addCommand({
            id: "open-batch-note-generator-view",
            name: "Open image metadata note generator",
            callback: async () => this.activateView()
        });

        this.addCommand({
            id: "load-current-note-into-batch-generator",
            name: "Load current note into image metadata note generator",
            callback: async () => {
                const view = await this.activateView();
                await view?.refreshFromCurrentNote();
            }
        });

        this.addCommand({
            id: "save-current-batch-job-to-note",
            name: "Save current image metadata job to current note",
            callback: async () => {
                const view = await this.activateView();
                await view?.saveToCurrentNote();
            }
        });

        this.addSettingTab(new ImageBatchNoteGeneratorSettingTab(this.app, this));
    }

    onunload() {
    }

    createDefaultJobConfig(): BatchJobConfig {
        return {
            inputFolder: this.settings.inputFolder,
            outputFolder: this.settings.outputFolder,
            tagsFolder: this.settings.tagsFolder,
            overwriteExisting: this.settings.overwriteExisting,
            deleteExtraNotes: this.settings.deleteExtraNotes,
            dryRun: this.settings.dryRun
        };
    }

    async loadSettings() {
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...(await this.loadData())
        };
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView(): Promise<ImageMetadataNoteGeneratorView | null> {
        let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE_BATCH_NOTE_GENERATOR)[0] ?? null;
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false);
        }

        if (!leaf) {
            new Notice("Could not open image metadata note generator view.");
            return null;
        }

        await leaf.setViewState({
            type: VIEW_TYPE_BATCH_NOTE_GENERATOR,
            active: true
        });
        this.app.workspace.revealLeaf(leaf);
        return leaf.view instanceof ImageMetadataNoteGeneratorView ? leaf.view : null;
    }
}
