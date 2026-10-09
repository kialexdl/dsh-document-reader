/** Bounded line windows; exceptionally long lines continue at exact UTF-8 positions. */
import type { Cache, Entry } from "./cache.js";
import { byteAtLine, lineAtByte } from "./cache.js";
import type { ReadArgs, ReadValue, Location } from "./types.js";
import { fail, jsonBytes } from "./errors.js";
export interface ReadState {
  position: number;
  line: number;
  limit: number;
}
export function utf8Prefix(buffer: Buffer, max: number): Buffer {
  let end = Math.min(max, buffer.length);
  if (end < buffer.length)
    while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end);
}
export async function locations(
  entry: Entry,
  start: number,
  end: number,
): Promise<Location[]> {
  const found: Location[] = [];
  const keys = new Set<string>();
  for (let p = 0; p < entry.mapping.size; ) {
    const record = (await entry.mapping.record(p))!;
    p = record.next;
    if (record.value.start >= end) break;
    if (record.value.end <= start) continue;
    const key = JSON.stringify(record.value.location);
    if (!keys.has(key)) {
      keys.add(key);
      found.push(record.value.location);
    }
    if (found.length >= 16) break;
  }
  return found;
}
export async function readWindow(
  cache: Cache,
  entry: Entry,
  args: ReadArgs,
  state?: ReadState,
  reserveBytes = 0,
): Promise<ReadValue> {
  const offset = state?.line ?? args.offset ?? 1,
    limit = state?.limit ?? args.limit ?? cache.config.read.maxLines;
  if (
    !Number.isInteger(offset) ||
    offset < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > cache.config.read.maxLines
  )
    fail(
      "DOCUMENT_ARGUMENT_INVALID",
      "offset/limit 必须为正整数，limit 不得超过配置上限。",
    );
  if (entry.meta.totalLines && offset > entry.meta.totalLines)
    fail("DOCUMENT_OFFSET_INVALID", "offset 超过转换文本总行数。");
  const start = state?.position ?? (await byteAtLine(entry, offset));
  const remainingLines = Math.max(
    0,
    Math.min(limit, entry.meta.totalLines - offset + 1),
  );
  const target =
    offset + limit <= entry.meta.totalLines
      ? await byteAtLine(entry, offset + limit)
      : entry.body.size;
  const raw = await entry.body.slice(
    start,
    Math.min(cache.config.read.maxBytes, target - start),
  );
  let selected = utf8Prefix(raw, raw.length);
  // A transfer chunk can end in the middle of a codepoint even at raw.length.
  if (start + selected.length < target) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let n = 0; n < 4; n++) {
      try {
        decoder.decode(selected);
        break;
      } catch {
        selected = selected.subarray(0, -1);
      }
    }
  }
  let locs = await locations(
    entry,
    start,
    start + Math.max(1, selected.length),
  );
  const placeholder = "00000000-0000-0000-0000-000000000000";
  const build = (b: Buffer): ReadValue => {
    const reached = start + b.length === target;
    const newline = b.lastIndexOf(10);
    const fragment = !reached && newline !== b.length - 1;
    const count = fragment
      ? 0
      : reached
        ? remainingLines
        : [...b].filter((c) => c === 10).length;
    const nextLine = offset + count;
    const eof = !fragment && nextLine > entry.meta.totalLines;
    return {
      file: entry.file,
      format: entry.format,
      document_revision: entry.revision,
      offset,
      returnedLines: count,
      totalLines: entry.meta.totalLines,
      nextOffset: eof || fragment ? null : nextLine,
      eof,
      content: b.toString("utf8"),
      locations: locs,
      line_fragment: fragment,
      fragment_start_byte: state || fragment ? start : null,
      next_read_args: eof
        ? null
        : fragment
          ? { file_path: entry.file, cursor: placeholder }
          : {
              file_path: entry.file,
              offset: nextLine,
              limit,
              expected_revision: entry.revision,
            },
      visionUsed: entry.meta.visionUsed,
      ocrUsed: entry.meta.ocrUsed,
      partial: entry.meta.partial,
      warnings: entry.meta.warnings,
      extraction_coverage: entry.meta.extraction_coverage,
    };
  };
  const max = cache.config.read.maxBytes - reserveBytes;
  if (jsonBytes(build(Buffer.alloc(0))) > max - 8) {
    locs = [];
    if (jsonBytes(build(Buffer.alloc(0))) > max - 8)
      fail("DOCUMENT_OUTPUT_BUDGET_TOO_SMALL", "文件信息和状态超出响应上限。");
  }
  let low = 0,
    high = selected.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(build(utf8Prefix(selected, middle))) <= max) low = middle;
    else high = middle - 1;
  }
  selected = utf8Prefix(selected, low);
  if (start + selected.length < target && selected.includes(10))
    selected = selected.subarray(0, selected.lastIndexOf(10) + 1);
  if (!selected.length && start < target)
    fail("DOCUMENT_OUTPUT_BUDGET_TOO_SMALL", "响应预算无法容纳正文。");
  const result = build(selected);
  if (result.line_fragment)
    result.next_read_args = {
      file_path: entry.file,
      cursor: cache.cursor(entry, "read", {
        position: start + selected.length,
        line: offset,
        limit,
      } satisfies ReadState),
    };
  return result;
}
/** Direct a long-line hit to its vicinity without forcing the model to count columns. */
export async function readArgsAt(
  cache: Cache,
  entry: Entry,
  byte: number,
): Promise<ReadArgs> {
  const line = await lineAtByte(entry, byte),
    start = await byteAtLine(entry, line);
  if (byte - start > cache.config.read.maxBytes / 2)
    return {
      file_path: entry.file,
      cursor: cache.cursor(entry, "read", {
        position: byte,
        line,
        limit: Math.min(40, cache.config.read.maxLines),
      } satisfies ReadState),
    };
  return {
    file_path: entry.file,
    offset: Math.max(1, line - 3),
    limit: Math.min(40, cache.config.read.maxLines),
    expected_revision: entry.revision,
  };
}
