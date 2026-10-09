import type { Context } from "@deepseek-ai/cordis";
import { type LiveConfig } from "./config.js";
export { PluginConfig as Config } from "./config.js";
export declare const name = "document-reader";
export declare const inject: string[];
export declare function apply(ctx: Context, config: LiveConfig): void;
