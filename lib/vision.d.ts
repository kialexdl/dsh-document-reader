/** Provider-neutral visual calls. Credentials and wire protocols stay in DSH. */
import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import type { Config } from "./config.js";
export interface VisionAnswer {
    ok: boolean;
    text?: string;
    code?: string;
}
export declare class DshVision {
    private readonly ctx;
    private readonly config;
    private readonly session?;
    private readonly unchanged;
    private calls;
    constructor(ctx: Context, config: Config["vision"], session?: Session | undefined, unchanged?: () => boolean);
    preflight(signal: AbortSignal): Promise<void>;
    private services;
    analyze(data: Buffer, mediaType: string, prompt: string, signal: AbortSignal): Promise<VisionAnswer>;
}
