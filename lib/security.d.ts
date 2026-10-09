/** Source reads always use the DSH filesystem provider, including cache hits. */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FsTarget, FsInfo } from "@deepseek-ai/dsh-fs";
export declare const formats: Set<string>;
export declare function validatePath(value: unknown): string;
export declare function resolveSource(ctx: Context, exec: ToolExecution, path: string): Promise<{
    target: FsTarget;
    info: FsInfo;
    format: string;
}>;
