/** OpenAI-compatible standalone route for progressive OCR. Redirects are never followed. */
import type { Config } from "./config.js";
import type { VisionAnswer } from "./vision.js";
export declare function standaloneVision(data: Buffer, prompt: string, config: Config, signal: AbortSignal, admit?: () => boolean): Promise<VisionAnswer>;
