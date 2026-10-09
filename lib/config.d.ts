/** Deployment controls; search semantics are deliberately not model parameters. */
import Schema from "@deepseek-ai/schemastery";
export interface Config {
    python: {
        executable: string;
        startupTimeoutMs: number;
        terminateGraceMs: number;
    };
    conversion: {
        timeoutMs: number;
        maxConcurrent: number;
        maxSourceMiB: number;
        maxResultMiB: number;
        sourceMemoryMiB: number;
        maxArchiveMiB: number;
        maxArchiveEntries: number;
        maxMapRecords: number;
        pdfDpi: number;
    };
    read: {
        maxLines: number;
        maxBytes: number;
    };
    search: {
        maxResults: number;
        maxBytes: number;
        maxKeywords: number;
        maxKeywordChars: number;
        snippetChars: number;
        scanTimeoutMs: number;
    };
    cache: {
        memoryEntryMiB: number;
        memoryTotalMiB: number;
        maxTotalMiB: number;
        ttlMinutes: number;
        partialTtlMinutes: number;
        sweepIntervalSeconds: number;
        maxCursors: number;
    };
    vision: {
        enabled: boolean;
        source: "auto" | "dsh" | "standalone";
        provider: string;
        maxImageMiB: number;
        maxResponseChars: number;
        baseURL: string;
        apiKeyEnv: string;
        model: string;
        requestTimeoutMs: number;
        maxRetries: number;
        maxCallsPerDocument: number;
        prompt: string;
    };
    ocr: {
        enabled: boolean;
    };
    progressive: {
        enabled: boolean;
        imageConcurrency: number;
        batchImages: number;
        waitMs: number;
        tilePixels: number;
        tileOverlap: number;
        maxTiles: number;
        maxImagePixels: number;
        persistent: boolean;
        directory: string;
        diskMiB: number;
        retentionDays: number;
        ocrPrompt: string;
        cacheVersion: string;
    };
}
export declare const Config: Schema<Config>;
export declare function validateConfig(config: Config): Config;
export declare const MiB: number;
/** Legacy endpoints stay independent until the user explicitly changes source. */
export declare function visionSource(config: Config): "dsh" | "standalone";
export type LiveConfig = {
    [K in keyof Config]: {
        get(): Config[K];
    };
};
export declare const PluginConfig: Schema<LiveConfig>;
export declare function snapshotConfig(config: LiveConfig): Config;
