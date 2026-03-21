import { App, PluginSettingTab, Setting } from "obsidian";
import type ImageBatchNoteGeneratorPlugin from "./main";
import { DEFAULT_SETTINGS } from "./types";

export class ImageBatchNoteGeneratorSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: ImageBatchNoteGeneratorPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Image Metadata Note Generator" });

        new Setting(containerEl)
            .setName("Default input folder")
            .setDesc("Vault-relative folder containing source images.")
            .addText((text) => text
                .setPlaceholder("Assets/Images")
                .setValue(this.plugin.settings.inputFolder)
                .onChange(async (value) => {
                    this.plugin.settings.inputFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Default output folder")
            .setDesc("Vault-relative folder where generated notes will be written.")
            .addText((text) => text
                .setPlaceholder("Notes/Image Metadata")
                .setValue(this.plugin.settings.outputFolder)
                .onChange(async (value) => {
                    this.plugin.settings.outputFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Default tags folder")
            .setDesc("Vault-relative folder used to discover known tag notes.")
            .addText((text) => text
                .setPlaceholder("Tags")
                .setValue(this.plugin.settings.tagsFolder)
                .onChange(async (value) => {
                    this.plugin.settings.tagsFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Default job note folder")
            .setDesc("Suggested folder for storing batch job notes.")
            .addText((text) => text
                .setPlaceholder("Batch Jobs")
                .setValue(this.plugin.settings.jobNoteFolder)
                .onChange(async (value) => {
                    this.plugin.settings.jobNoteFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Overwrite existing by default")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.overwriteExisting)
                .onChange(async (value) => {
                    this.plugin.settings.overwriteExisting = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Delete extra notes by default")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.deleteExtraNotes)
                .onChange(async (value) => {
                    this.plugin.settings.deleteExtraNotes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Dry run by default")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.dryRun)
                .onChange(async (value) => {
                    this.plugin.settings.dryRun = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Reset defaults")
            .setDesc("Restore plugin defaults for future jobs.")
            .addButton((button) => button
                .setButtonText("Reset")
                .onClick(async () => {
                    this.plugin.settings = { ...DEFAULT_SETTINGS };
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }
}
