import {
    AbstractInputSuggest,
    App,
    debounce,
    ItemView,
    Notice,
    Plugin,
    Setting,
    TFile,
    TFolder,
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
import { DEFAULT_JOB_CONFIG, DEFAULT_SETTINGS, JOB_NOTE_TYPE, type BatchJobConfig, type PluginSettings, type RunReport, type ScanReport } from "./types";

export const VIEW_TYPE_BATCH_NOTE_GENERATOR = "image-metadata-note-generator-view";

class FolderPathSuggest extends AbstractInputSuggest<string> {
    constructor(app: App, private text: TextComponent, private getMaxSuggestions: () => number) {
        super(app, text.inputEl);
    }

    protected getSuggestions(query: string): string[] {
        const normalizedQuery = normalizeFolderInput(query).toLowerCase();
        return this.app.vault.getAllLoadedFiles()
            .filter((file): file is TFolder => file instanceof TFolder)
            .map((folder) => folder.path)
            .filter((path) => path.length > 0)
            .sort((left, right) => left.localeCompare(right))
            .filter((path) => !normalizedQuery || path.toLowerCase().includes(normalizedQuery))
            .slice(0, this.getMaxSuggestions());
    }

    renderSuggestion(value: string, el: HTMLElement) {
        el.setText(value);
    }

    selectSuggestion(value: string): void {
        this.text.setValue(value);
        this.text.onChanged();
        this.close();
    }
}

class ImageMetadataNoteGeneratorView extends ItemView {
    private state: BatchJobConfig;
    private statusEl: HTMLDivElement | null = null;
    private logEl: HTMLTextAreaElement | null = null;
    private activeJobEl: HTMLDivElement | null = null;
    private noteActionEl: HTMLDivElement | null = null;
    private inspectorBodyEl: HTMLDivElement | null = null;
    private runHintEl: HTMLDivElement | null = null;
    private inputFolderText: TextComponent | null = null;
    private outputFolderText: TextComponent | null = null;
    private tagsFolderText: TextComponent | null = null;
    private templateNoteText: TextComponent | null = null;
    private skipOverwriteToggle: ToggleComponent | null = null;
    private skipDeleteExtraToggle: ToggleComponent | null = null;
    private dryRunToggle: ToggleComponent | null = null;
    private isBusy = false;
    private linkedNote: TFile | null = null;
    private suppressAutoSave = false;
    private readonly debouncedAutoSave: () => void;

    constructor(leaf: WorkspaceLeaf, private plugin: ImageBatchNoteGeneratorPlugin) {
        super(leaf);
        this.state = plugin.createDefaultJobConfig();
        this.debouncedAutoSave = debounce(() => {
            void this.persistStateToLinkedNote();
        }, 500, true);
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
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
            void this.handleActiveFileChange();
        }));
        this.registerEvent(this.app.metadataCache.on("changed", (file) => {
            void this.handleMetadataChange(file);
        }));
        this.render();
        await this.handleActiveFileChange();
    }

    async onClose() {
        this.debouncedAutoSave();
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
        this.linkedNote = file;
        this.setStatus(`Loaded job from ${file.path}`);
        this.renderActiveJob(file);
    }

    async createJobFromCurrentNote() {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
            new Notice("Open a Markdown note to use it as an image metadata job.");
            return;
        }

        await saveJobConfigToNote(this.app.fileManager, file, this.state);
        this.linkedNote = file;
        this.setControlsDisabled(false);
        this.renderActiveJob(file);
        this.setStatus(`Initialized job note at ${file.path}`);
        new Notice("Current note is now an image metadata job.");
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("image-metadata-note-generator-view");

        contentEl.createEl("h2", { text: "Image Metadata Note Generator" });
        contentEl.createEl("p", {
            text: "The current job note is the source of truth. Edit frontmatter through this inspector, then scan or run it."
        });

        const currentFile = this.app.workspace.getActiveFile();
        this.activeJobEl = contentEl.createDiv({ cls: "image-metadata-note-generator-active-note" });
        this.renderActiveJob(currentFile instanceof TFile ? currentFile : null);
        this.noteActionEl = contentEl.createDiv({ cls: "image-metadata-note-generator-note-actions" });
        this.inspectorBodyEl = contentEl.createDiv({ cls: "image-metadata-note-generator-inspector-body" });

        new Setting(this.inspectorBodyEl)
            .setName("Input folder")
            .setDesc("Source image folder inside the vault.")
            .addText((text) => {
                this.inputFolderText = text;
                new FolderPathSuggest(this.app, text, () => this.plugin.getMaxSuggestionCount());
                text.setPlaceholder("Assets/Images");
                text.setValue(this.state.inputFolder);
                text.onChange((value) => {
                    this.state.inputFolder = normalizeFolderInput(value);
                    this.scheduleAutoSave();
                });
            });

        new Setting(this.inspectorBodyEl)
            .setName("Output folder")
            .setDesc("Destination folder for generated Markdown notes.")
            .addText((text) => {
                this.outputFolderText = text;
                new FolderPathSuggest(this.app, text, () => this.plugin.getMaxSuggestionCount());
                text.setPlaceholder("Notes/Image Metadata");
                text.setValue(this.state.outputFolder);
                text.onChange((value) => {
                    this.state.outputFolder = normalizeFolderInput(value);
                    this.scheduleAutoSave();
                });
            });

        new Setting(this.inspectorBodyEl)
            .setName("Tags folder")
            .setDesc("Folder containing existing tag notes for longest-match splitting.")
            .addText((text) => {
                this.tagsFolderText = text;
                new FolderPathSuggest(this.app, text, () => this.plugin.getMaxSuggestionCount());
                text.setPlaceholder("Tags");
                text.setValue(this.state.tagsFolder);
                text.onChange((value) => {
                    this.state.tagsFolder = normalizeFolderInput(value);
                    this.scheduleAutoSave();
                });
            });

        new Setting(this.inspectorBodyEl)
            .setName("Template note")
            .setDesc("Optional Markdown note whose body is rendered with Handlebars. Leave empty to use the built-in default template.")
            .addText((text) => {
                this.templateNoteText = text;
                text.setPlaceholder("Templates/Image Metadata Default.md");
                text.setValue(this.state.templateNote);
                text.onChange((value) => {
                    this.state.templateNote = normalizeFolderInput(value);
                    this.scheduleAutoSave();
                });
            });

        new Setting(this.inspectorBodyEl)
            .setName("Do not overwrite existing")
            .addToggle((toggle) => {
                this.skipOverwriteToggle = toggle;
                toggle.setValue(this.state.skipOverwriteExisting);
                toggle.onChange((value) => {
                    this.state.skipOverwriteExisting = value;
                    this.scheduleAutoSave();
                });
            });

        new Setting(this.inspectorBodyEl)
            .setName("Do not delete extra notes")
            .setDesc("By default, Markdown files under the output folder that are not produced by the current run are deleted.")
            .addToggle((toggle) => {
                this.skipDeleteExtraToggle = toggle;
                toggle.setValue(this.state.skipDeleteExtraNotes);
                toggle.onChange((value) => {
                    this.state.skipDeleteExtraNotes = value;
                    this.scheduleAutoSave();
                });
            });

        new Setting(this.inspectorBodyEl)
            .setName("Dry run")
            .setDesc("Compute changes without writing files.")
            .addToggle((toggle) => {
                this.dryRunToggle = toggle;
                toggle.setValue(this.state.dryRun);
                toggle.onChange((value) => {
                    this.state.dryRun = value;
                    this.updateRunHint();
                    this.scheduleAutoSave();
                });
            });

        const actions = this.inspectorBodyEl.createDiv({ cls: "image-metadata-note-generator-actions" });
        this.createButton(actions, "Scan current job", async () => {
            await this.handleScan();
        });
        this.createButton(actions, "Run current job", async () => {
            await this.handleRun();
        }, "mod-cta");
        this.createButton(actions, "Reset fields to defaults", async () => {
            this.state = this.plugin.createDefaultJobConfig();
            this.syncControls();
            this.updateRunHint();
            this.scheduleAutoSave();
            this.setStatus(this.linkedNote ? "Restored defaults for current job." : "Restored defaults.");
        });
        this.runHintEl = this.inspectorBodyEl.createDiv({ cls: "image-metadata-note-generator-run-hint" });
        this.updateRunHint();

        this.statusEl = this.inspectorBodyEl.createDiv({ cls: "image-metadata-note-generator-status" });
        this.setStatus("Ready.");

        this.inspectorBodyEl.createEl("h3", { text: "Log" });
        this.logEl = this.inspectorBodyEl.createEl("textarea", { cls: "image-metadata-note-generator-log" });
        this.logEl.readOnly = true;
        this.logEl.value = "";
        this.setControlsDisabled(true);
    }

    private renderActiveJob(file: TFile | null) {
        if (!this.activeJobEl) return;
        this.activeJobEl.empty();
        const label = this.activeJobEl.createDiv({ cls: "image-metadata-note-generator-active-note-label" });
        label.setText("Current note");
        const value = this.activeJobEl.createDiv({ cls: "image-metadata-note-generator-active-note-value" });
        value.setText(file?.path ?? "None");
        const hint = this.activeJobEl.createDiv({ cls: "image-metadata-note-generator-active-note-label" });
        if (!file) {
            hint.setText("Open a Markdown note to inspect or run a batch job.");
        } else if (this.linkedNote?.path === file.path) {
            hint.setText("This note is a job note. Field edits auto-save to its frontmatter.");
        } else {
            hint.setText("This note is not a job note yet.");
        }
        this.renderNoteActions(file);
    }

    private createButton(container: HTMLElement, text: string, handler: () => Promise<void>, cls?: string) {
        const button = container.createEl("button", { text });
        if (cls) {
            button.addClass(cls);
        }
        button.addEventListener("click", async () => {
            if (this.isBusy) return;
            await handler();
        });
    }

    private syncControls() {
        this.suppressAutoSave = true;
        this.inputFolderText?.setValue(this.state.inputFolder);
        this.outputFolderText?.setValue(this.state.outputFolder);
        this.tagsFolderText?.setValue(this.state.tagsFolder);
        this.templateNoteText?.setValue(this.state.templateNote);
        this.skipOverwriteToggle?.setValue(this.state.skipOverwriteExisting);
        this.skipDeleteExtraToggle?.setValue(this.state.skipDeleteExtraNotes);
        this.dryRunToggle?.setValue(this.state.dryRun);
        this.suppressAutoSave = false;
        this.updateRunHint();
    }

    private setControlsDisabled(disabled: boolean) {
        this.inputFolderText?.setDisabled(disabled);
        this.outputFolderText?.setDisabled(disabled);
        this.tagsFolderText?.setDisabled(disabled);
        this.templateNoteText?.setDisabled(disabled);
        this.skipOverwriteToggle?.setDisabled(disabled);
        this.skipDeleteExtraToggle?.setDisabled(disabled);
        this.dryRunToggle?.setDisabled(disabled);
        this.inspectorBodyEl?.toggleClass("image-metadata-note-generator-is-readonly", disabled);
        this.inspectorBodyEl?.toggleClass("image-metadata-note-generator-is-hidden", disabled);
    }

    private scheduleAutoSave() {
        if (this.suppressAutoSave) return;
        this.debouncedAutoSave();
    }

    private updateRunHint() {
        if (!this.runHintEl) return;
        if (this.state.dryRun) {
            this.runHintEl.removeClass("is-write");
            this.runHintEl.addClass("is-dry-run");
            this.runHintEl.setText("Dry run is enabled. Run will preview changes without writing files.");
            return;
        }

        this.runHintEl.removeClass("is-dry-run");
        this.runHintEl.addClass("is-write");
        this.runHintEl.setText("Run writes files. It may create or update notes, and can delete extra notes when that option is enabled.");
    }

    private async handleActiveFileChange() {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
            this.linkedNote = null;
            this.state = this.plugin.createDefaultJobConfig();
            this.syncControls();
            this.setControlsDisabled(true);
            this.renderActiveJob(null);
            return;
        }

        const loaded = loadJobConfigFromNote(this.app, file);
        if (!loaded) {
            this.linkedNote = null;
            this.state = this.plugin.createDefaultJobConfig();
            this.syncControls();
            this.setControlsDisabled(true);
            this.renderActiveJob(file);
            this.setStatus(`Open a job note or initialize ${file.path} as one.`);
            return;
        }

        this.linkedNote = file;
        this.state = {
            ...this.plugin.createDefaultJobConfig(),
            ...loaded
        };
        this.syncControls();
        this.setControlsDisabled(false);
        this.renderActiveJob(file);
        this.setStatus(`Auto-loaded job from ${file.path}`);
    }

    private async handleMetadataChange(file: TFile) {
        if (!this.linkedNote || file.path !== this.linkedNote.path) return;
        const loaded = loadJobConfigFromNote(this.app, file);
        if (!loaded) return;

        const nextState: BatchJobConfig = {
            ...this.plugin.createDefaultJobConfig(),
            ...loaded
        };
        if (this.isSameState(nextState, this.state)) return;

        this.state = nextState;
        this.syncControls();
        this.setControlsDisabled(false);
        this.renderActiveJob(file);
        this.setStatus(`Synced job from ${file.path}`);
    }

    private async persistStateToLinkedNote() {
        const file = this.linkedNote;
        if (!file) return;
        if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) {
            this.linkedNote = null;
            this.renderActiveJob(null);
            return;
        }

        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (frontmatter?.type !== JOB_NOTE_TYPE) return;

        await saveJobConfigToNote(this.app.fileManager, file, this.state);
        this.setStatus(`Auto-saved job to ${file.path}`);
    }

    private renderNoteActions(file: TFile | null) {
        if (!this.noteActionEl) return;
        this.noteActionEl.empty();
        if (!file) return;

        if (file.extension !== "md") {
            this.noteActionEl.createDiv({
                cls: "image-metadata-note-generator-note-action-text",
                text: "Only Markdown notes can be used as batch job notes."
            });
            return;
        }

        if (this.linkedNote?.path === file.path) {
            this.noteActionEl.createDiv({
                cls: "image-metadata-note-generator-note-action-text",
                text: "Inspector is bound to the current job note."
            });
            return;
        }

        this.noteActionEl.createDiv({
            cls: "image-metadata-note-generator-note-action-text",
            text: "Use this note as a batch job to edit its frontmatter with folder suggestions."
        });
        const button = this.noteActionEl.createEl("button", {
            cls: "mod-cta",
            text: "Use current note as job note"
        });
        button.addEventListener("click", async () => {
            if (this.isBusy) return;
            await this.createJobFromCurrentNote();
        });
    }

    private isSameState(left: BatchJobConfig, right: BatchJobConfig): boolean {
        return left.inputFolder === right.inputFolder
            && left.outputFolder === right.outputFolder
            && left.tagsFolder === right.tagsFolder
            && left.templateNote === right.templateNote
            && left.skipOverwriteExisting === right.skipOverwriteExisting
            && left.skipDeleteExtraNotes === right.skipDeleteExtraNotes
            && left.dryRun === right.dryRun;
    }

    private validateState(): string | null {
        if (!this.linkedNote) return "Open a job note first.";
        if (!this.state.inputFolder) return "Input folder is required.";
        if (!this.state.outputFolder) return "Output folder is required.";
        if (this.state.inputFolder === this.state.outputFolder) return "Input and output folders must be different.";
        return null;
    }

    async handleScan() {
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

    async handleRun() {
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
            id: "initialize-current-note-as-batch-job",
            name: "Use current note as image metadata job",
            callback: async () => {
                const view = await this.activateView();
                await view?.createJobFromCurrentNote();
            }
        });

        this.addCommand({
            id: "scan-current-batch-job-note",
            name: "Scan current image metadata job note",
            callback: async () => {
                const view = await this.activateView();
                await view?.handleScan();
            }
        });

        this.addCommand({
            id: "run-current-batch-job-note",
            name: "Run current image metadata job note",
            callback: async () => {
                const view = await this.activateView();
                await view?.handleRun();
            }
        });

        this.addSettingTab(new ImageBatchNoteGeneratorSettingTab(this.app, this));

        this.registerMarkdownPostProcessor((el, context) => {
            const section = context.getSectionInfo(el);
            if (section && section.lineStart > 0) {
                return;
            }

            const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
            if (!(file instanceof TFile) || !this.isJobNote(file)) {
                return;
            }

            if (el.querySelector(".image-metadata-note-generator-inline-cta")) {
                return;
            }

            const wrapper = createDiv({ cls: "image-metadata-note-generator-inline-cta" });
            wrapper.createDiv({
                cls: "image-metadata-note-generator-inline-cta-text",
                text: "This note is an image metadata job."
            });

            const button = wrapper.createEl("button", {
                cls: "mod-cta",
                text: "Open inspector"
            });
            button.addEventListener("click", () => {
                void this.activateView();
            });

            el.prepend(wrapper);
        });

        this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
            void this.maybeAutoOpenInspector();
        }));

        await this.maybeAutoOpenInspector();
    }

    onunload() {
    }

    createDefaultJobConfig(): BatchJobConfig {
        return { ...DEFAULT_JOB_CONFIG };
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

    getMaxSuggestionCount(): number {
        return Number.isFinite(this.settings.maxSuggestionCount) && this.settings.maxSuggestionCount > 0
            ? this.settings.maxSuggestionCount
            : DEFAULT_SETTINGS.maxSuggestionCount;
    }

    isJobNote(file: TFile): boolean {
        return this.app.metadataCache.getFileCache(file)?.frontmatter?.type === JOB_NOTE_TYPE;
    }

    private async maybeAutoOpenInspector() {
        if (!this.settings.autoOpenInspector) return;
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md" || !this.isJobNote(file)) return;
        await this.activateView();
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
