import type { Config } from "./config.js";
import type { Metadata, Segment } from "./types.js";
export declare class ByteStore {
    private readonly directory;
    private readonly memoryLimit;
    private memory;
    private handle;
    private path;
    private chunks;
    private recordWindow?;
    size: number;
    constructor(directory: string, memoryLimit: number);
    get memoryBytes(): number;
    append(data: Buffer): Promise<void>;
    finish(): void;
    slice(start: number, length: number): Promise<Buffer>;
    record(position: number): Promise<{
        value: Segment;
        next: number;
    } | undefined>;
    dispose(): Promise<void>;
}
export interface Entry {
    key: string;
    session: string;
    file: string;
    format: string;
    revision: string;
    body: ByteStore;
    mapping: ByteStore;
    meta: Metadata;
    index: Array<{
        line: number;
        byte: number;
    }>;
    created: number;
    accessed: number;
    pins: number;
    expired: boolean;
    size: number;
    memory: number;
}
interface Cursor {
    bytes: number;
    session: string;
    key: string;
    revision: string;
    kind: "read" | "search";
    state: unknown;
    created: number;
}
export declare class Cache {
    private readonly initialConfig;
    private readonly secureDirectory?;
    readConfig?: () => Config;
    get config(): Config;
    readonly entries: Map<string, Entry>;
    private cursors;
    private reservations;
    private queue;
    private rootPromise;
    private exception;
    constructor(initialConfig: Config, secureDirectory?: ((path: string) => Promise<void>) | undefined);
    secure(path: string): Promise<void>;
    root(): Promise<string>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    reserve(key: string, bytes: number, approve: (bytes: number) => Promise<void>): Promise<void>;
    private usedExcept;
    releaseReservation(key: string): void;
    memoryAvailable(): number;
    publish(entry: Entry): Promise<void>;
    acquire(key: string, expected?: string): Promise<Entry | undefined>;
    invalidate(key: string): Promise<void>;
    unpin(entry: Entry): Promise<void>;
    cursor(entry: Entry, kind: Cursor["kind"], state: unknown): string;
    getCursor(id: string, session: string, key: string, kind: Cursor["kind"]): Cursor;
    discardCursor(id: string): void;
    private isExpired;
    sweep(session?: string): Promise<void>;
    private remove;
    dispose(): Promise<void>;
}
/** Build a sparse index and verify complete UTF-8 plus mapping continuity before publication. */
export declare function validateEntry(entry: Entry, signal?: AbortSignal, indexBudget?: number): Promise<void>;
export declare function byteAtLine(entry: Entry, line: number): Promise<number>;
export declare function lineAtByte(entry: Entry, position: number): Promise<number>;
export {};
