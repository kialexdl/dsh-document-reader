/** Wire and tool values. Byte positions refer to the immutable UTF-8 conversion. */
export type Source = "native" | "ocr_transcript" | "generated_description" | "mixed_or_unknown" | "metadata";
export type Scope = "page" | "slide" | "block" | "sheet" | "record" | "image";
export interface Location {
    kind: Scope;
    page?: number;
    slide?: number;
    sheet?: string;
    record?: number;
    block?: string;
    heading?: string[];
    part?: string;
    hidden?: boolean;
}
export interface Segment {
    start: number;
    end: number;
    startLine: number;
    endLine: number;
    scope: string;
    location: Location;
    source: Source;
}
export interface Metadata {
    protocol: 1;
    ok: true;
    bodyBytes: number;
    mapBytes: number;
    records: number;
    totalLines: number;
    scope: Scope;
    visionUsed: boolean;
    ocrUsed: boolean;
    partial: boolean;
    warnings: string[];
    extraction_coverage: "no_known_gaps" | "known_gaps" | "unknown";
    excluded_content: string[];
}
export interface ReadArgs {
    file_path: string;
    offset?: number;
    limit?: number;
    expected_revision?: string;
    cursor?: string;
    image_offset?: number;
    image_id?: string;
    block_id?: string;
    image_mode?: "transcription" | "description";
}
export interface SearchArgs {
    scope?: "all" | "text";
    file_path: string;
    keywords?: string[];
    require_all?: boolean;
    cursor?: string;
}
export interface ImageProgress {
    total: number;
    completed: number;
    failed: number;
    pending: number;
    skipped: number;
    running: boolean;
}
export interface ReadValue {
    next_images_args?: ReadArgs | null;
    images?: Array<{
        id: string;
        block_id: string;
        status: string;
        read_args: ReadArgs;
    }>;
    image_progress?: ImageProgress;
    file: string;
    format: string;
    document_revision: string;
    offset: number;
    returnedLines: number;
    totalLines: number;
    nextOffset: number | null;
    eof: boolean;
    content: string;
    locations: Location[];
    line_fragment: boolean;
    fragment_start_byte: number | null;
    next_read_args: ReadArgs | null;
    visionUsed: boolean;
    ocrUsed: boolean;
    partial: boolean;
    warnings: string[];
    extraction_coverage: Metadata["extraction_coverage"];
}
export interface Snippet {
    location: Location;
    keyword: string;
    source: "native" | "ocr_transcript";
    start_line: number;
    end_line: number;
    text: string;
    read_args: ReadArgs;
}
export interface SearchResult {
    result_id?: string;
    update?: boolean;
    location: Location;
    matched_keywords: string[];
    snippets: Snippet[];
    snippets_truncated: boolean;
}
export interface SearchValue {
    image_progress?: ImageProgress;
    search_scope?: "all" | "text";
    extraction_complete?: boolean;
    file: string;
    format: string;
    document_revision: string;
    effective_scope: Scope;
    keywords: string[];
    require_all: boolean;
    results: SearchResult[];
    scan_complete: boolean;
    has_more: boolean | null;
    next_search_args: {
        file_path: string;
        cursor: string;
    } | null;
    partial: boolean;
    extraction_coverage: Metadata["extraction_coverage"];
    excluded_content: string[];
    warnings: string[];
}
