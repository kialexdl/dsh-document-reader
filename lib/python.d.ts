/** Managed subprocess protocol; no source path is passed to the Python parser. */
import type { Context } from "@deepseek-ai/cordis";
import type { FsTarget, FsInfo } from "@deepseek-ai/dsh-fs";
import type { Config } from "./config.js";
import type { DshVision } from "./vision.js";
import { Cache } from "./cache.js";
import type { Entry } from "./cache.js";
import type { Metadata } from "./types.js";
export declare function validateMeta(value: unknown, config: Config): Metadata;
export declare class PythonBridge {
    private readonly ctx;
    private readonly config;
    private readonly cache;
    private readonly executables;
    private readonly handles;
    constructor(ctx: Context, config: Config, cache: Cache);
    private spawn;
    private stop;
    private discover;
    convert(input: {
        key: string;
        session: string;
        file: string;
        format: string;
        target: FsTarget;
        info: FsInfo;
        signal: AbortSignal;
        config?: Config;
        vision?: DshVision;
        deferredDir?: string;
    }, approve: (bytes: number) => Promise<void>): Promise<Entry>;
    prepareImage(source: string, directory: string, config: Config, signal: AbortSignal): Promise<{
        tiles: string[];
        warning?: string;
    }>;
    dispose(): Promise<void>;
}
