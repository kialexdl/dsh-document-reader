import { test } from "node:test";
import assert from "node:assert/strict";
import { Cache, ByteStore, validateEntry } from "../src/cache.js";
import type { Entry } from "../src/cache.js";
import { Config } from "../src/config.js";
import { search, searchInput } from "../src/search.js";
import type { SearchState } from "../src/search.js";
import { readWindow } from "../src/read.js";
import type { ReadState } from "../src/read.js";
import { validatePath } from "../src/security.js";
import type { Segment, Source, ReadArgs } from "../src/types.js";

async function fixture(
  chunks: Array<{ text: string; page: number; source?: Source }>,
  disk = false,
) {
  const config = Config({});
  const cache = new Cache(config),
    root = await cache.root();
  const body = new ByteStore(root, disk ? 0 : 1024 * 1024),
    mapping = new ByteStore(root, disk ? 0 : 1024 * 1024);
  let line = 1,
    position = 0;
  for (const c of chunks) {
    const bytes = Buffer.from(c.text);
    const seg: Segment = {
      start: position,
      end: position + bytes.length,
      startLine: line,
      endLine: line + (c.text.match(/\n/gu)?.length ?? 0),
      scope: "page:" + c.page,
      location: { kind: "page", page: c.page },
      source: c.source ?? "native",
    };
    await body.append(bytes);
    await mapping.append(Buffer.from(JSON.stringify(seg) + "\n"));
    position += bytes.length;
    line = seg.endLine;
  }
  body.finish();
  mapping.finish();
  const now = Date.now();
  const entry: Entry = {
    key: "key",
    session: "session",
    file: "测试.pdf",
    format: "pdf",
    revision: "rev-one",
    body,
    mapping,
    index: [],
    created: now,
    accessed: now,
    pins: 0,
    expired: false,
    size: body.size + mapping.size,
    memory: 0,
    meta: {
      protocol: 1,
      ok: true,
      bodyBytes: body.size,
      mapBytes: mapping.size,
      records: chunks.length,
      totalLines: body.size ? line : 0,
      scope: "page",
      visionUsed: false,
      ocrUsed: false,
      partial: false,
      warnings: [],
      extraction_coverage: "no_known_gaps",
      excluded_content: [],
    },
  };
  await validateEntry(entry);
  await cache.publish(entry);
  return { cache, entry };
}
test("literal matching preserves punctuation, ignores case, and excludes generated text", async () => {
  const { cache, entry } = await fixture([
    { page: 1, text: "C++ a.b node_count OpenStack\n" },
    { page: 2, text: "generated-only", source: "generated_description" },
  ]);
  try {
    for (const k of ["C++", "a.b", "node", "OPENSTACK"])
      assert.equal(
        (
          await search(
            cache,
            entry,
            searchInput({ file_path: entry.file, keywords: [k] }, cache),
          )
        ).results.length,
        1,
      );
    assert.equal(
      (
        await search(
          cache,
          entry,
          searchInput(
            { file_path: entry.file, keywords: ["generated-only"] },
            cache,
          ),
        )
      ).results.length,
      0,
    );
    assert.equal(
      (
        await search(
          cache,
          entry,
          searchInput({ file_path: entry.file, keywords: ["node*"] }, cache),
        )
      ).results.length,
      0,
    );
  } finally {
    await cache.dispose();
  }
});
test("ALL stays within one physical page and phrases never cross source segments", async () => {
  const { cache, entry } = await fixture([
    { page: 1, text: "primary " },
    { page: 2, text: "failover" },
    { page: 3, text: "primary " },
    { page: 3, text: "failover" },
  ]);
  try {
    const all = await search(
      cache,
      entry,
      searchInput(
        {
          file_path: entry.file,
          keywords: ["primary", "failover"],
          require_all: true,
        },
        cache,
      ),
    );
    assert.deepEqual(
      all.results.map((x) => x.location.page),
      [3],
    );
    assert.equal(
      (
        await search(
          cache,
          entry,
          searchInput(
            { file_path: entry.file, keywords: ["primary failover"] },
            cache,
          ),
        )
      ).results.length,
      0,
    );
  } finally {
    await cache.dispose();
  }
});
test("NFC maps decomposed characters back to original bytes and crosses streaming chunks", async () => {
  const { cache, entry } = await fixture(
    [{ page: 1, text: "x".repeat(16382) + "e\u0301 OpenStack 中文" }],
    true,
  );
  try {
    const r = await search(
      cache,
      entry,
      searchInput({ file_path: entry.file, keywords: ["é OpenStack"] }, cache),
    );
    assert.equal(r.results.length, 1);
    assert.match(r.results[0]!.snippets[0]!.text, /e\u0301/u);
  } finally {
    await cache.dispose();
  }
});
test("bounded results resume in document order without duplicates", async () => {
  const { cache, entry } = await fixture(
    Array.from({ length: 7 }, (_, i) => ({
      page: i + 1,
      text: "needle " + i + "\n",
    })),
  );
  cache.config.search.maxResults = 2;
  try {
    let state = searchInput(
      { file_path: entry.file, keywords: ["needle"] },
      cache,
    );
    const pages: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await search(cache, entry, state);
      pages.push(...r.results.map((x) => x.location.page!));
      assert.ok(
        Buffer.byteLength(JSON.stringify(r)) <= cache.config.search.maxBytes,
      );
      if (!r.next_search_args) {
        assert.equal(r.scan_complete, true);
        break;
      }
      state = cache.getCursor(
        r.next_search_args.cursor,
        entry.session,
        entry.key,
        "search",
      ).state as SearchState;
    }
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    await cache.dispose();
  }
});
test("large Chinese line is completely recoverable in bounded fragments", async () => {
  const text = "中文🙂".repeat(3000) + "\nlast line\n";
  const { cache, entry } = await fixture([{ page: 1, text }], true);
  cache.config.read.maxBytes = 4096;
  try {
    let args: ReadArgs = { file_path: entry.file },
      state: ReadState | undefined,
      combined = "";
    for (let i = 0; i < 100; i++) {
      const r = await readWindow(cache, entry, args, state);
      assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 4096);
      assert.ok(!r.content.includes("\uFFFD"));
      combined += r.content;
      if (!r.next_read_args) {
        assert.equal(r.eof, true);
        break;
      }
      args = r.next_read_args;
      state = args.cursor
        ? (cache.getCursor(args.cursor, entry.session, entry.key, "read")
            .state as ReadState)
        : undefined;
    }
    assert.equal(combined, text);
  } finally {
    await cache.dispose();
  }
});
test("limit one preserves empty final line and nextOffset semantics", async () => {
  const { cache, entry } = await fixture([
    { page: 1, text: "first\nsecond\n" },
  ]);
  try {
    const a = await readWindow(cache, entry, {
      file_path: entry.file,
      limit: 1,
    });
    assert.equal(a.content, "first\n");
    assert.equal(a.nextOffset, 2);
    const b = await readWindow(cache, entry, a.next_read_args!);
    assert.equal(b.content, "second\n");
    assert.equal(b.nextOffset, 3);
    const c = await readWindow(cache, entry, b.next_read_args!);
    assert.equal(c.content, "");
    assert.equal(c.eof, true);
  } finally {
    await cache.dispose();
  }
});
test("revision and cursor fail after eviction; session isolation applies", async () => {
  const { cache, entry } = await fixture([{ page: 1, text: "needle" }]);
  try {
    const id = cache.cursor(entry, "search", {});
    assert.throws(
      () => cache.getCursor(id, "different", entry.key, "search"),
      /DOCUMENT_CURSOR_INVALID/,
    );
    entry.expired = true;
    await cache.sweep();
    await assert.rejects(
      cache.acquire(entry.key, entry.revision),
      /DOCUMENT_REVISION_EXPIRED/,
    );
    assert.throws(
      () => cache.getCursor(id, entry.session, entry.key, "search"),
      /DOCUMENT_CURSOR_INVALID/,
    );
  } finally {
    await cache.dispose();
  }
});
test("invalid query rejected and cancelled search emits no results", async () => {
  const { cache, entry } = await fixture([{ page: 1, text: "text" }]);
  try {
    assert.throws(
      () => searchInput({ file_path: entry.file, keywords: [" "] }, cache),
      /DOCUMENT_QUERY_INVALID/,
    );
    await assert.rejects(
      search(
        cache,
        entry,
        searchInput({ file_path: entry.file, keywords: ["text"] }, cache),
        AbortSignal.abort(),
      ),
      /DOCUMENT_CANCELLED/,
    );
  } finally {
    await cache.dispose();
  }
});
test("path rules allow ordinary UNC but reject URL, drive-relative, devices and ADS", () => {
  for (const p of [
    "https://host/a.pdf",
    "D:a.pdf",
    "C:\\docs\\a.pdf:ads",
    "\\\\.\\pipe\\a.pdf",
    "file:///a.pdf",
  ])
    assert.throws(() => validatePath(p));
  assert.equal(validatePath("D:\\中文 空格\\文档.pdf"), "pdf");
  assert.equal(validatePath("\\\\server\\share\\a.docx"), "docx");
});
test("partial cache has an absolute lifetime even when accessed", async () => {
  const { cache, entry } = await fixture([{ page: 1, text: "partial" }]);
  try {
    entry.meta.partial = true;
    entry.created =
      Date.now() - cache.config.cache.partialTtlMinutes * 60000 - 1;
    entry.accessed = Date.now();
    assert.equal(await cache.acquire(entry.key), undefined);
  } finally {
    await cache.dispose();
  }
});
test("read and search output remain within a small budget with multiple snippets", async () => {
  const { cache, entry } = await fixture([
    {
      page: 1,
      text: ("keyword1 keyword2 keyword3 " + "中".repeat(100) + "\n").repeat(
        20,
      ),
    },
  ]);
  cache.config.search.maxBytes = 4096;
  try {
    const r = await search(
      cache,
      entry,
      searchInput(
        {
          file_path: entry.file,
          keywords: ["keyword1", "keyword2", "keyword3"],
          require_all: true,
        },
        cache,
      ),
    );
    assert.equal(r.results.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 4096);
    assert.deepEqual(r.results[0]!.matched_keywords, [
      "keyword1",
      "keyword2",
      "keyword3",
    ]);
  } finally {
    await cache.dispose();
  }
});
