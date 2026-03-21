export const JOB_NOTE_FLAG = "imgbatch_job";

export type BatchJobConfig = {
    inputFolder: string;
    outputFolder: string;
    tagsFolder: string;
    overwriteExisting: boolean;
    deleteExtraNotes: boolean;
    dryRun: boolean;
};

export type PluginSettings = BatchJobConfig & {
    jobNoteFolder: string;
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
    inputFolder: "",
    outputFolder: "",
    tagsFolder: "",
    overwriteExisting: true,
    deleteExtraNotes: false,
    dryRun: false,
    jobNoteFolder: "Batch Jobs"
};
