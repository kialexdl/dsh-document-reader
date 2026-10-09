/** Tool orchestration: one conversion per session/source/config, with shared cancellation. */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { type Config } from "./config.js";
import { Cache } from "./cache.js";
import type { ReadArgs, SearchArgs, ReadValue, SearchValue } from "./types.js";
export declare class DocumentReader {
    private readonly ctx;
    readonly config: Config;
    private readonly readConfig;
    readonly cache: Cache;
    private readonly python;
    private readonly progressive;
    private readonly flights;
    private readonly active;
    private readonly lifetime;
    private modelEpoch;
    invalidateModels(): void;
    private timer;
    private disposed;
    constructor(ctx: Context, config: Config, readConfig?: () => Config);
    refreshConfig(): void;
    private track;
    invoke(kind: "read" | "search", args: ReadArgs | SearchArgs, exec: ToolExecution): Promise<ReadValue | SearchValue>;
    private run;
    disposeSession(session: string): void;
    dispose(): Promise<void>;
}
export declare function registerTools(ctx: Context, reader: DocumentReader): void;
