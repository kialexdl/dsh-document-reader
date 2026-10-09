/** Literal Unicode search with format-owned scopes and bounded resumable scanning. */
import type { Cache, Entry } from "./cache.js";
import type { SearchArgs, SearchResult, SearchValue, Location } from "./types.js";
interface Hit {
    byte: number;
    source: "native" | "ocr_transcript";
    location: Location;
    end: number;
}
export interface SearchState {
    keywords: string[];
    require_all: boolean;
    mapPosition: number;
    byte: number;
    scope: string;
    location: Location | null;
    hits: Array<Hit | null>;
    carry: string;
    carryOffsets: number[];
    pending: SearchResult | null;
}
export declare function searchInput(args: SearchArgs, cache: Cache): SearchState;
export declare function search(cache: Cache, entry: Entry, state: SearchState, signal?: AbortSignal, reserveBytes?: number): Promise<SearchValue>;
export {};
