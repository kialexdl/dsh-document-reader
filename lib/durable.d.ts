import type { Config } from "./config.js";
import type { Entry, Cache } from "./cache.js";
export declare const digest: (value: unknown) => string;
export declare class DurableStore {
    private cache;
    private roots;
    private queue;
    constructor(cache: Cache);
    private root;
    private serial;
    loadDocument(key: string, destination: string, config: Config): Promise<boolean>;
    saveDocument(key: string, entry: Entry, assets: string, config: Config): Promise<void>;
    getResult(key: string, config: Config): Promise<string | undefined>;
    putResult(key: string, text: string, config: Config): Promise<void>;
    private sweep;
}
