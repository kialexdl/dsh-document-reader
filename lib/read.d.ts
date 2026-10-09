/** Bounded line windows; exceptionally long lines continue at exact UTF-8 positions. */
import type { Cache, Entry } from "./cache.js";
import type { ReadArgs, ReadValue, Location } from "./types.js";
export interface ReadState {
    position: number;
    line: number;
    limit: number;
}
export declare function utf8Prefix(buffer: Buffer, max: number): Buffer;
export declare function locations(entry: Entry, start: number, end: number): Promise<Location[]>;
export declare function readWindow(cache: Cache, entry: Entry, args: ReadArgs, state?: ReadState, reserveBytes?: number): Promise<ReadValue>;
/** Direct a long-line hit to its vicinity without forcing the model to count columns. */
export declare function readArgsAt(cache: Cache, entry: Entry, byte: number): Promise<ReadArgs>;
