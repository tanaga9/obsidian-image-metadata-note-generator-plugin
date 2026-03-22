import { App, FileManager, TFile, normalizePath } from "obsidian";
import Handlebars from "handlebars";
import { parseImageMeta } from "./parser";
import { convertTag, extractModelNames, promptToTags, splitPromptAndParameters, splitTagByKnownNotes, transformColons, type ConvertedTag } from "./prompt";
import { JOB_NOTE_TYPE } from "./types";
import type { BatchJobConfig, RunReport, ScanReport } from "./types";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
export const DEFAULT_NOTE_TEMPLATE = `---
generated: true
source_image: {{image.path}}
prompt: |-
{{yamlIndentedPrompt}}
---
{{image.embed}}

{{#if tagsInline}}
{{tagsInline}}

{{/if}}
{{#each models}}
- [[{{../tagBaseFolder}}/Model/{{fullName}}]] ([[{{name}}]])
{{/each}}
{{#if models.length}}

{{/if}}
{{#if tags.length}}
| Tag | Page | danbooru | civitai | google |
| ---- | ---- | -------- | ------- | ------ |
{{#each tags}}
| \`{{original}}\` | [[{{../tagBaseFolder}}/{{original}}]] ([[{{name}}]]) | [?](https://danbooru.donmai.us/wiki_pages/{{quotedTagUnderscore}}) [{{name}}](https://danbooru.donmai.us/posts?tags={{quotedTagUnderscore}}) | [civitai](https://civitai.com/search/models?query={{quotedTag}}) | [google](https://www.google.com/search?q={{quotedTag}}) |
{{/each}}

{{/if}}
# parameters

\`\`\`
{{parameters}}
\`\`\`
`;

type PreparedNote = {
    imageFile: TFile;
    outputPath: string;
    markdown: string;
};

type TemplateModel = {
    fullName: string;
    name: string;
};

type TemplateContext = {
    image: {
        path: string;
        name: string;
        embed: string;
    };
    tagBaseFolder: string;
    prompt: string;
    yamlIndentedPrompt: string;
    parameters: string;
    tags: ConvertedTag[];
    tagsInline: string;
    models: TemplateModel[];
};

export async function scanBatchJob(app: App, config: BatchJobConfig): Promise<ScanReport> {
    const imageFiles = getImageFilesInFolder(app, config.inputFolder);
    let imagesWithMetadata = 0;
    const imagesWithoutMetadata: string[] = [];
    let existingOutputCount = 0;

    for (const imageFile of imageFiles) {
        const parameters = await readParametersForImage(app, imageFile);
        if (parameters) {
            imagesWithMetadata++;
        } else {
            imagesWithoutMetadata.push(imageFile.path);
        }
        const outputPath = buildOutputPath(config.outputFolder, config.inputFolder, imageFile);
        if (app.vault.getAbstractFileByPath(outputPath) instanceof TFile) {
            existingOutputCount++;
        }
    }

    return {
        imageCount: imageFiles.length,
        matchedImagePaths: imageFiles.map((file) => file.path),
        imagesWithMetadata,
        imagesWithoutMetadata,
        existingOutputCount
    };
}

export async function runBatchJob(
    app: App,
    config: BatchJobConfig,
    onLog?: (line: string) => void
): Promise<RunReport> {
    const imageFiles = getImageFilesInFolder(app, config.inputFolder);
    const knownTags = getKnownTagSet(app, config.tagsFolder);
    const preparedNotes: PreparedNote[] = [];
    const failed: string[] = [];

    for (const imageFile of imageFiles) {
        try {
            const parameters = await readParametersForImage(app, imageFile);
            if (!parameters) {
                failed.push(`${imageFile.path}: metadata not found`);
                onLog?.(`skip ${imageFile.path} (metadata not found)`);
                continue;
            }

            const markdown = await buildMarkdownForImage(app, config, imageFile, parameters, knownTags);
            preparedNotes.push({
                imageFile,
                outputPath: buildOutputPath(config.outputFolder, config.inputFolder, imageFile),
                markdown
            });
        } catch (error) {
            failed.push(`${imageFile.path}: ${String(error)}`);
            onLog?.(`error ${imageFile.path}`);
        }
    }

    const report: RunReport = {
        scanned: imageFiles.length,
        created: 0,
        updated: 0,
        skipped: 0,
        deleted: 0,
        failed
    };

    if (config.dryRun) {
        for (const item of preparedNotes) {
            const existing = app.vault.getAbstractFileByPath(item.outputPath);
            if (!(existing instanceof TFile)) report.created++;
            else report.updated++;
        }
        if (!config.skipDeleteExtraNotes) {
            report.deleted = countExtraNotes(app, config.outputFolder, preparedNotes.map((item) => item.outputPath));
        }
        return report;
    }

    for (const item of preparedNotes) {
        const existing = app.vault.getAbstractFileByPath(item.outputPath);
        if (existing instanceof TFile) {
            const current = await app.vault.read(existing);
            if (current === item.markdown) {
                report.skipped++;
                onLog?.(`unchanged ${item.outputPath}`);
                continue;
            }
            if (config.skipOverwriteExisting) {
                report.skipped++;
                onLog?.(`skip existing ${item.outputPath}`);
                continue;
            }
            await app.vault.modify(existing, item.markdown);
            report.updated++;
            onLog?.(`updated ${item.outputPath}`);
            continue;
        }

        await ensureFolderExists(app, parentFolder(item.outputPath));
        await app.vault.create(item.outputPath, item.markdown);
        report.created++;
        onLog?.(`created ${item.outputPath}`);
    }

    if (!config.skipDeleteExtraNotes) {
        report.deleted = await deleteExtraNotes(app, config.outputFolder, preparedNotes.map((item) => item.outputPath), onLog);
    }

    return report;
}

export function normalizeFolderInput(path: string | null | undefined): string {
    if (typeof path !== "string") return "";
    return path.replace(/^\/+|\/+$/g, "").trim();
}

export async function saveJobConfigToNote(fileManager: FileManager, file: TFile, config: BatchJobConfig): Promise<void> {
    await fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter.type = JOB_NOTE_TYPE;
        frontmatter.input_folder = config.inputFolder;
        frontmatter.output_folder = config.outputFolder;
        if (config.tagsFolder) frontmatter.tags_folder = config.tagsFolder;
        else delete frontmatter.tags_folder;
        if (config.templateNote) frontmatter.template_note = config.templateNote;
        else delete frontmatter.template_note;
        if (config.skipOverwriteExisting) frontmatter.skip_overwrite_existing = true;
        else delete frontmatter.skip_overwrite_existing;
        if (config.skipDeleteExtraNotes) frontmatter.skip_delete_extra_notes = true;
        else delete frontmatter.skip_delete_extra_notes;
        if (config.dryRun) frontmatter.dry_run = true;
        else delete frontmatter.dry_run;
        delete frontmatter.overwrite_existing;
        delete frontmatter.delete_extra_notes;
    });
}

export function loadJobConfigFromNote(app: App, file: TFile): Partial<BatchJobConfig> | null {
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter || frontmatter.type !== JOB_NOTE_TYPE) {
        return null;
    }

    const legacyOverwriteExisting = booleanProp(frontmatter.overwrite_existing);
    const legacyDeleteExtraNotes = booleanProp(frontmatter.delete_extra_notes);

    return {
        inputFolder: stringProp(frontmatter.input_folder),
        outputFolder: stringProp(frontmatter.output_folder),
        tagsFolder: stringProp(frontmatter.tags_folder),
        templateNote: stringProp(frontmatter.template_note),
        skipOverwriteExisting: booleanProp(frontmatter.skip_overwrite_existing)
            ?? (legacyOverwriteExisting != null ? !legacyOverwriteExisting : undefined),
        skipDeleteExtraNotes: booleanProp(frontmatter.skip_delete_extra_notes)
            ?? (legacyDeleteExtraNotes != null ? !legacyDeleteExtraNotes : undefined),
        dryRun: booleanProp(frontmatter.dry_run)
    };
}

function stringProp(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function booleanProp(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function getImageFilesInFolder(app: App, folderPath: string): TFile[] {
    const normalizedFolder = normalizeFolderInput(folderPath);
    return app.vault.getFiles()
        .filter((file) => IMAGE_EXTENSIONS.has(file.extension.toLowerCase()))
        .filter((file) => isWithinFolder(file.path, normalizedFolder))
        .sort((a, b) => a.path.localeCompare(b.path));
}

function isWithinFolder(filePath: string, folderPath: string): boolean {
    if (!folderPath) return false;
    return filePath === folderPath || filePath.startsWith(`${folderPath}/`);
}

async function readParametersForImage(app: App, imageFile: TFile): Promise<string | null> {
    const buf = await app.vault.adapter.readBinary(imageFile.path);
    const meta = await parseImageMeta(buf, imageFile.extension.toLowerCase());
    const fields = meta.fields as Record<string, unknown>;

    const parametersRaw = typeof fields.parameters_raw === "string" ? fields.parameters_raw : null;
    if (parametersRaw) return parametersRaw;
    if (typeof meta.raw.parameters === "string") return meta.raw.parameters;
    if (typeof fields.prompt === "string" && typeof fields.negative_prompt === "string") {
        return `${fields.prompt}\nNegative prompt: ${fields.negative_prompt}`;
    }
    return null;
}

function buildOutputPath(outputFolder: string, inputFolder: string, imageFile: TFile): string {
    const normalizedOutput = normalizeFolderInput(outputFolder);
    const normalizedInput = normalizeFolderInput(inputFolder);
    const rel = imageFile.path.startsWith(`${normalizedInput}/`)
        ? imageFile.path.slice(normalizedInput.length + 1)
        : imageFile.name;
    const relWithoutExt = rel.replace(/\.[^.]+$/, "");
    return normalizePath(`${normalizedOutput}/${relWithoutExt}.md`);
}

async function buildMarkdownForImage(
    app: App,
    config: BatchJobConfig,
    imageFile: TFile,
    parameters: string,
    knownTags: Set<string>
): Promise<string> {
    const template = await loadTemplateSource(app, config.templateNote);
    const renderer = Handlebars.compile(template, { noEscape: true });
    return renderer(createTemplateContext(config, imageFile, parameters, knownTags));
}

function createTemplateContext(
    config: BatchJobConfig,
    imageFile: TFile,
    parameters: string,
    knownTags: Set<string>
): TemplateContext {
    const { prompt } = splitPromptAndParameters(parameters);
    const rawTags = promptToTags(prompt);
    const tagEntries = rawTags.flatMap((tag) => {
        const source = tag.startsWith("<") && tag.endsWith(">")
            ? transformColons(tag.slice(1, -1))
            : tag;
        return splitTagByKnownNotes(source, knownTags)
            .filter((piece) => piece && !piece.startsWith(":"))
            .map(convertTag);
    });

    const uniqueTags = dedupeTags(tagEntries);
    const models = extractModelNames(parameters).map((model) => ({
        fullName: model,
        name: model.split("/").pop() ?? model
    }));

    return {
        image: {
            path: imageFile.path,
            name: imageFile.basename,
            embed: `![[${imageFile.path}]]`
        },
        tagBaseFolder: normalizeFolderInput(config.tagsFolder) || "Tags",
        prompt,
        yamlIndentedPrompt: indentBlock(prompt).join("\n"),
        parameters,
        tags: uniqueTags,
        tagsInline: formatInlineTags(uniqueTags),
        models
    };
}

async function loadTemplateSource(app: App, templateNotePath: string): Promise<string> {
    const normalizedTemplatePath = normalizeFolderInput(templateNotePath);
    if (!normalizedTemplatePath) {
        return DEFAULT_NOTE_TEMPLATE;
    }

    const abstractFile = app.vault.getAbstractFileByPath(normalizedTemplatePath);
    if (!(abstractFile instanceof TFile) || abstractFile.extension !== "md") {
        throw new Error(`Template note not found: ${normalizedTemplatePath}`);
    }

    return await app.vault.read(abstractFile);
}

function dedupeTags(tags: ReturnType<typeof convertTag>[]): ReturnType<typeof convertTag>[] {
    const seen = new Set<string>();
    const out: ReturnType<typeof convertTag>[] = [];
    for (const tag of tags) {
        if (seen.has(tag.original)) continue;
        seen.add(tag.original);
        out.push(tag);
    }
    return out;
}

function formatInlineTags(tags: ReturnType<typeof convertTag>[]): string {
    const seen = new Set<string>();
    const inlineTags: string[] = [];

    for (const tag of tags) {
        if (!tag.obsidianTag || seen.has(tag.obsidianTag)) {
            continue;
        }

        seen.add(tag.obsidianTag);
        inlineTags.push(`#${tag.obsidianTag}`);
    }

    return inlineTags.join(" ");
}

function indentBlock(text: string): string[] {
    if (!text) return ["  "];
    return text.split(/\r?\n/).map((line) => `  ${line}`);
}

function getKnownTagSet(app: App, tagsFolder: string): Set<string> {
    const normalized = normalizeFolderInput(tagsFolder);
    const known = new Set<string>();
    if (!normalized) return known;

    for (const file of app.vault.getMarkdownFiles()) {
        if (!isWithinFolder(file.path, normalized)) continue;
        const relative = file.path.slice(normalized.length).replace(/^\//, "").replace(/\.md$/i, "");
        if (!relative || relative.startsWith(".")) continue;
        known.add(relative);
    }

    return known;
}

async function ensureFolderExists(app: App, folder: string): Promise<void> {
    const normalized = normalizeFolderInput(folder);
    if (!normalized) return;
    if (app.vault.getAbstractFileByPath(normalized)) return;
    const parent = parentFolder(normalized);
    if (parent && !app.vault.getAbstractFileByPath(parent)) {
        await ensureFolderExists(app, parent);
    }
    await app.vault.createFolder(normalized);
}

function parentFolder(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? "" : path.slice(0, idx);
}

function countExtraNotes(app: App, outputFolder: string, keepPaths: string[]): number {
    const keep = new Set(keepPaths.map((path) => normalizePath(path)));
    return app.vault.getMarkdownFiles()
        .filter((file) => isWithinFolder(file.path, normalizeFolderInput(outputFolder)))
        .filter((file) => isGeneratedOutputNote(app, file))
        .filter((file) => !keep.has(normalizePath(file.path)))
        .length;
}

async function deleteExtraNotes(app: App, outputFolder: string, keepPaths: string[], onLog?: (line: string) => void): Promise<number> {
    const keep = new Set(keepPaths.map((path) => normalizePath(path)));
    let deleted = 0;
    for (const file of app.vault.getMarkdownFiles()) {
        if (!isWithinFolder(file.path, normalizeFolderInput(outputFolder))) continue;
        if (keep.has(normalizePath(file.path))) continue;
        if (!isGeneratedOutputNote(app, file)) {
            onLog?.(`skip delete ${file.path} (missing generated: true)`);
            continue;
        }
        await app.vault.delete(file);
        deleted++;
        onLog?.(`deleted ${file.path}`);
    }
    return deleted;
}

function isGeneratedOutputNote(app: App, file: TFile): boolean {
    return app.metadataCache.getFileCache(file)?.frontmatter?.generated === true;
}
