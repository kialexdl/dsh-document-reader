/** Literal Unicode search with format-owned scopes and bounded resumable scanning. */
import type { Cache, Entry } from "./cache.js";
import { lineAtByte } from "./cache.js";
import { readArgsAt, utf8Prefix } from "./read.js";
import type {
  Segment,
  SearchArgs,
  SearchResult,
  SearchValue,
  Location,
  Snippet,
} from "./types.js";
import { fail, aborted, jsonBytes } from "./errors.js";
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
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
export function searchInput(args: SearchArgs, cache: Cache): SearchState {
  if (
    !Array.isArray(args.keywords) ||
    !args.keywords.length ||
    args.keywords.length > cache.config.search.maxKeywords ||
    args.keywords.some(
      (k) =>
        typeof k !== "string" ||
        !k.trim() ||
        [...k].length > cache.config.search.maxKeywordChars,
    )
  )
    fail(
      "DOCUMENT_QUERY_INVALID",
      "keywords 必须为非空字符串数组，数量/长度不得超过插件配置。",
    );
  if (args.require_all !== undefined && typeof args.require_all !== "boolean")
    fail("DOCUMENT_QUERY_INVALID", "require_all 必须为布尔值。");
  return {
    keywords: args.keywords,
    require_all: args.require_all ?? false,
    mapPosition: 0,
    byte: 0,
    scope: "",
    location: null,
    hits: args.keywords.map(() => null),
    carry: "",
    carryOffsets: [],
    pending: null,
  };
}
async function finishScope(
  cache: Cache,
  entry: Entry,
  state: SearchState,
): Promise<SearchResult | null> {
  const found = state.hits.filter(Boolean);
  if (
    !found.length ||
    (state.require_all && found.length !== state.keywords.length)
  )
    return null;
  const snippets: Snippet[] = [];
  for (let i = 0; i < state.hits.length; i++) {
    const h = state.hits[i];
    if (!h) continue;
    const raw = await entry.body.slice(
      h.byte,
      Math.min(cache.config.search.snippetChars * 4, h.end - h.byte),
    );
    const text = [...new TextDecoder().decode(raw)]
      .slice(0, cache.config.search.snippetChars)
      .join("")
      .replace(/\uFFFD$/u, "");
    const start = await lineAtByte(entry, h.byte);
    snippets.push({
      location: h.location,
      keyword: state.keywords[i]!,
      source: h.source,
      start_line: start,
      end_line: start + (text.match(/\n/gu)?.length ?? 0),
      text,
      read_args: await readArgsAt(cache, entry, h.byte),
    });
  }
  return {
    location: state.location!,
    matched_keywords: state.keywords.filter((_, i) => !!state.hits[i]),
    snippets,
    snippets_truncated: false,
  };
}
async function scanChunk(
  entry: Entry,
  segment: Segment,
  state: SearchState,
  patterns: RegExp[],
): Promise<boolean> {
  const position = Math.max(segment.start, state.byte);
  const raw = await entry.body.slice(
    position,
    Math.min(16384, segment.end - position),
  );
  let data = utf8Prefix(raw, raw.length);
  if (position + data.length < segment.end) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let n = 0; n < 4; n++) {
      try {
        decoder.decode(data);
        break;
      } catch {
        data = data.subarray(0, -1);
      }
    }
  }
  const text = data.toString("utf8");
  const groups = [...graphemes.segment(text)];
  // Retain the final grapheme in the source for normalization across chunk boundaries.
  let consumed = data.length;
  if (position + data.length < segment.end && groups.length) {
    const last = groups.pop()!;
    consumed = Buffer.byteLength(text.slice(0, last.index));
    if (!consumed)
      fail(
        "DOCUMENT_SEARCH_TEXT_LIMIT",
        "单个 Unicode 字素过长，无法在有界搜索窗口内规范化。",
      );
  }
  let normalized = state.carry;
  const offsets = [...state.carryOffsets];
  let byte = position;
  for (const g of groups) {
    const n = g.segment.normalize("NFC");
    normalized += n;
    for (let i = 0; i < n.length; i++) offsets.push(byte);
    byte += Buffer.byteLength(g.segment);
  }
  for (let i = 0; i < patterns.length; i++)
    if (!state.hits[i]) {
      const match = patterns[i]!.exec(normalized);
      if (match)
        state.hits[i] = {
          byte: offsets[match.index]!,
          end: segment.end,
          source: segment.source as Hit["source"],
          location: segment.location,
        };
    }
  const keep =
    Math.max(...state.keywords.map((k) => k.normalize("NFC").length)) + 2;
  state.carry = normalized.slice(-keep);
  state.carryOffsets = offsets.slice(-keep);
  state.byte = position + consumed;
  return state.byte >= segment.end;
}
export async function search(
  cache: Cache,
  entry: Entry,
  state: SearchState,
  signal?: AbortSignal,
  reserveBytes = 0,
): Promise<SearchValue> {
  state = structuredClone(state);
  const config = {
      ...cache.config.search,
      maxBytes: cache.config.search.maxBytes - reserveBytes,
    },
    deadline = Date.now() + config.scanTimeoutMs;
  const patterns = state.keywords.map(
    (k) => new RegExp(escape(k.normalize("NFC")), "iu"),
  );
  const result: SearchValue = {
    file: entry.file,
    format: entry.format,
    document_revision: entry.revision,
    effective_scope: entry.meta.scope,
    keywords: state.keywords,
    require_all: state.require_all,
    results: [],
    scan_complete: false,
    has_more: null,
    next_search_args: {
      file_path: entry.file,
      cursor: "00000000-0000-0000-0000-000000000000",
    },
    partial: entry.meta.partial,
    extraction_coverage: entry.meta.extraction_coverage,
    excluded_content: entry.meta.excluded_content,
    warnings: entry.meta.warnings,
  };
  if (jsonBytes(result) > config.maxBytes - 128)
    fail("DOCUMENT_OUTPUT_BUDGET_TOO_SMALL", "查询与文件元数据超过响应上限。");
  const appendPending = (): boolean => {
    if (!state.pending) return true;
    if (result.results.length >= config.maxResults) return false;
    result.results.push(state.pending);
    if (jsonBytes(result) > config.maxBytes) {
      result.results.pop();
      if (result.results.length) return false;
      while (
        state.pending.snippets.length > 1 &&
        jsonBytes({ ...result, results: [state.pending] }) > config.maxBytes
      ) {
        state.pending.snippets.pop();
        state.pending.snippets_truncated = true;
      }
      while (
        state.pending.snippets[0] &&
        jsonBytes({ ...result, results: [state.pending] }) > config.maxBytes
      ) {
        const s = state.pending.snippets[0];
        s.text = [...s.text]
          .slice(0, Math.floor([...s.text].length / 2))
          .join("");
        state.pending.snippets_truncated = true;
        if (!s.text)
          fail(
            "DOCUMENT_OUTPUT_BUDGET_TOO_SMALL",
            "一个命中范围的元数据超过响应上限。",
          );
      }
      result.results.push(state.pending);
    }
    state.pending = null;
    return true;
  };
  let finished = false;
  while (true) {
    aborted(signal);
    if (!appendPending()) break;
    if (result.results.length >= config.maxResults || Date.now() >= deadline)
      break;
    const record = await entry.mapping.record(state.mapPosition);
    if (!record) {
      state.pending = await finishScope(cache, entry, state);
      state.scope = "";
      state.hits = state.keywords.map(() => null);
      finished = true;
      appendPending();
      break;
    }
    const seg = record.value;
    if (state.scope !== seg.scope) {
      if (state.scope) {
        state.pending = await finishScope(cache, entry, state);
      }
      state.scope = seg.scope;
      state.location = seg.location;
      state.hits = state.keywords.map(() => null);
      if (!appendPending()) break;
      if (result.results.length >= config.maxResults) break;
    }
    if (seg.source === "native" || seg.source === "ocr_transcript") {
      const done =
        state.hits.every(Boolean) ||
        (await scanChunk(entry, seg, state, patterns));
      if (!done) continue;
    }
    state.mapPosition = record.next;
    state.byte = 0;
    state.carry = "";
    state.carryOffsets = [];
  }
  if (finished && !state.pending) {
    result.scan_complete = true;
    result.has_more = false;
    result.next_search_args = null;
  } else {
    result.has_more = state.pending ? true : null;
    result.next_search_args = {
      file_path: entry.file,
      cursor: cache.cursor(entry, "search", state),
    };
  }
  return result;
}
