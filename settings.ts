import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_NOTE_TEMPLATE } from "./generator";
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
            .setName("Auto-open inspector")
            .setDesc("Open the right-side inspector automatically when you switch to a job note. Disabled by default.")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.autoOpenInspector)
                .onChange(async (value) => {
                    this.plugin.settings.autoOpenInspector = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Max folder suggestions")
            .setDesc("Maximum number of folder path suggestions shown in inspector fields.")
            .addText((text) => text
                .setPlaceholder("50")
                .setValue(String(this.plugin.settings.maxSuggestionCount))
                .onChange(async (value) => {
                    const parsed = Number.parseInt(value.trim(), 10);
                    this.plugin.settings.maxSuggestionCount = Number.isFinite(parsed) && parsed > 0
                        ? parsed
                        : DEFAULT_SETTINGS.maxSuggestionCount;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Reset defaults")
            .setDesc("Restore plugin-wide UI defaults.")
            .addButton((button) => button
                .setButtonText("Reset")
                .onClick(async () => {
                    this.plugin.settings = { ...DEFAULT_SETTINGS };
                    await this.plugin.saveSettings();
                    this.display();
                }));

        containerEl.createEl("h3", { text: "Built-in Default Template" });
        containerEl.createEl("p", {
            text: "Used when a job note leaves template_note empty. This preview is read-only."
        });

        const templatePreview = containerEl.createEl("textarea", {
            cls: "image-metadata-note-generator-template-preview"
        });
        templatePreview.readOnly = true;
        templatePreview.value = DEFAULT_NOTE_TEMPLATE;
    }
}
