export const JOB_NOTE_TYPE = "image-metadata-note-generator-job";

export type BatchJobConfig = {
    inputFolder: string;
    outputFolder: string;
    tagsFolder: string;
    templateNote: string;
    skipOverwriteExisting: boolean;
    skipDeleteExtraNotes: boolean;
    dryRun: boolean;
};

export const DEFAULT_JOB_CONFIG: BatchJobConfig = {
    inputFolder: "",
    outputFolder: "",
    tagsFolder: "",
    templateNote: "",
    skipOverwriteExisting: false,
    skipDeleteExtraNotes: false,
    dryRun: false
};

export type PluginSettings = {
    autoOpenInspector: boolean;
    maxSuggestionCount: number;
};

export type ScanReport = {
    imageCount: number;
    matchedImagePaths: string[];
    imagesWithMetadata: number;
    imagesWithoutMetadata: string[];
    existingOutputCount: number;
};

export type RunReport = {
    scanned: number;
    created: number;
    updated: number;
    skipped: number;
    deleted: number;
    failed: string[];
};

export const DEFAULT_SETTINGS: PluginSettings = {
    autoOpenInspector: false,
    maxSuggestionCount: 50
};
