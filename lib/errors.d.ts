/** Expected failures carry a stable code and a credential-free explanation. */
export declare class DocumentError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function fail(code: string, message: string): never;
export declare function aborted(signal?: AbortSignal): void;
export declare function jsonBytes(value: unknown): number;
