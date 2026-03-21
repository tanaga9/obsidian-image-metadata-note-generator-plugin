import { App, FileManager, TFile, normalizePath } from "obsidian";
import { parseImageMeta } from "./parser";
import { convertTag, extractModelNames, promptToTags, splitPromptAndParameters, splitTagByKnownNotes, transformColons } from "./prompt";
import type { BatchJobConfig, RunReport, ScanReport } from "./types";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

type PreparedNote = {
    imageFile: TFile;
    outputPath: string;
    markdown: string;
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

            const markdown = buildMarkdownForImage(imageFile, parameters, knownTags);
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
        if (config.deleteExtraNotes) {
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
            if (!config.overwriteExisting) {
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

    if (config.deleteExtraNotes) {
        report.deleted = await deleteExtraNotes(app, config.outputFolder, preparedNotes.map((item) => item.outputPath), onLog);
    }

    return report;
}

export function normalizeFolderInput(path: string): string {
    return path.replace(/^\/+|\/+$/g, "").trim();
}

export async function saveJobConfigToNote(fileManager: FileManager, file: TFile, config: BatchJobConfig): Promise<void> {
    await fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter.imgbatch_job = true;
        frontmatter.input_folder = config.inputFolder;
        frontmatter.output_folder = config.outputFolder;
        frontmatter.tags_folder = config.tagsFolder;
        frontmatter.overwrite_existing = config.overwriteExisting;
        frontmatter.delete_extra_notes = config.deleteExtraNotes;
        frontmatter.dry_run = config.dryRun;
    });
}

export function loadJobConfigFromNote(app: App, file: TFile): Partial<BatchJobConfig> | null {
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter || !frontmatter.imgbatch_job) {
        return null;
    }

    return {
        inputFolder: stringProp(frontmatter.input_folder),
        outputFolder: stringProp(frontmatter.output_folder),
        tagsFolder: stringProp(frontmatter.tags_folder),
        overwriteExisting: booleanProp(frontmatter.overwrite_existing),
        deleteExtraNotes: booleanProp(frontmatter.delete_extra_notes),
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

function buildMarkdownForImage(imageFile: TFile, parameters: string, knownTags: Set<string>): string {
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
    const models = extractModelNames(parameters);
    const lines: string[] = [];

    lines.push("---");
    lines.push("imgbatch_generated: true");
    lines.push(`source_image: ${imageFile.path}`);
    lines.push("prompt: |-");
    lines.push(...indentBlock(prompt));
    lines.push("---");
    lines.push(`![[${imageFile.path}]]`);
    lines.push("");

    if (uniqueTags.length > 0) {
        lines.push(uniqueTags.map((tag) => `#${tag.quotedTagUnderscore}`).join(" "));
        lines.push("");
    }

    for (const model of models) {
        lines.push(`- [[Tags/Model/${model}]] ([[${model.split("/").pop() ?? model}]])`);
    }

    if (models.length > 0) {
        lines.push("");
    }

    if (uniqueTags.length > 0) {
        lines.push("| Tag | Page | danbooru | civitai | google |");
        lines.push("| ---- | ---- | -------- | ------- | ------ |");
        for (const tag of uniqueTags) {
            lines.push(
                `| \`${tag.original}\` | [[Tags/${tag.original}]] ([[${tag.name}]]) | ` +
                `[?](https://danbooru.donmai.us/wiki_pages/${tag.quotedTagUnderscore}) ` +
                `[${tag.name}](https://danbooru.donmai.us/posts?tags=${tag.quotedTagUnderscore}) | ` +
                `[civitai](https://civitai.com/search/models?query=${tag.quotedTag}) | ` +
                `[google](https://www.google.com/search?q=${tag.quotedTag}) |`
            );
        }
        lines.push("");
    }

    lines.push("# parameters");
    lines.push("");
    lines.push("```");
    lines.push(parameters);
    lines.push("```");
    lines.push("");

    return lines.join("\n");
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
        .filter((file) => !keep.has(normalizePath(file.path)))
        .length;
}

async function deleteExtraNotes(app: App, outputFolder: string, keepPaths: string[], onLog?: (line: string) => void): Promise<number> {
    const keep = new Set(keepPaths.map((path) => normalizePath(path)));
    let deleted = 0;
    for (const file of app.vault.getMarkdownFiles()) {
        if (!isWithinFolder(file.path, normalizeFolderInput(outputFolder))) continue;
        if (keep.has(normalizePath(file.path))) continue;
        await app.vault.delete(file);
        deleted++;
        onLog?.(`deleted ${file.path}`);
    }
    return deleted;
}
