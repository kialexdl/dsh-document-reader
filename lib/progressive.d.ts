/** DOCX native-first reading, bounded image batches and restartable checkpoints. */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FsTarget, FsInfo } from "@deepseek-ai/dsh-fs";
import type { Config } from "./config.js";
import { Cache } from "./cache.js";
import { PythonBridge } from "./python.js";
import type { ReadArgs, ReadValue, SearchArgs, SearchValue } from "./types.js";
export declare class ProgressiveReader {
    private ctx;
    private cache;
    private python;
    private legacyConversions;
    private documents;
    private tokens;
    private durable;
    private lifetime;
    private epoch;
    private imageQueue;
    private building;
    private nativeFlights;
    constructor(ctx: Context, cache: Cache, python: PythonBridge, legacyConversions?: () => number);
    get activeConversions(): number;
    invalidate(): void;
    private modeKey;
    private token;
    private authorize;
    private buildDocument;
    private run;
    private image;
    /** Publish once, using a unique file so a cancelled worker cannot overwrite it. */
    private publishImage;
    /** Explicit image reads bypass the background queue and wait for their model result. */
    private directImage;
    private start;
    private progress;
    private wait;
    private snapshot;
    invoke(kind: "read" | "search", args: ReadArgs | SearchArgs, exec: ToolExecution, target: FsTarget, info: FsInfo, config: Config): Promise<ReadValue | SearchValue>;
    private query;
    private finishSearch;
    private read;
    private remove;
    sweep(session?: string): Promise<void>;
    dispose(): Promise<void>;
}
