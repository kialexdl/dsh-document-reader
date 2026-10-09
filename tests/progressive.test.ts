import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, {
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import LocalAttachments from "@deepseek-ai/dsh-attachment-local";
import FsLocal from "@deepseek-ai/dsh-fs-local";
import SubprocessLocal from "@deepseek-ai/dsh-subprocess-local";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Config } from "../src/config.js";
import { DocumentReader } from "../src/tool.js";
import type { SearchValue, ReadValue, SearchArgs } from "../src/types.js";
const python = process.env.DOCUMENT_READER_TEST_PYTHON;
class Adapter extends LlmAdapter {
  count = 0;
  active = 0;
  peak = 0;
  fail = false;
  hold = false;
  descriptionCalls = 0;
  controlled = false;
  gates = new Map<number, () => void>();
  cancelled: number[] = [];
  async listModels(provider: string) {
    return [
      {
        provider,
        id: "vision",
        name: "Vision",
        inputModalities: ["text", "image"] as const,
      },
    ];
  }
  async resolveModel(provider: string, id: string) {
    return {
      provider,
      id,
      name: id,
      inputModalities: ["text", "image"] as const,
    };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.count++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    const n = this.count,
      cancelled = this.cancelled;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          done,
          this.hold || this.controlled ? 60000 : 100,
        );
        if (this.controlled) this.gates.set(n, done);
        function done() {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
          resolve();
        }
        function cancel() {
          cancelled.push(n);
          clearTimeout(timer);
          reject(Error("aborted"));
        }
        options.signal?.addEventListener("abort", cancel, { once: true });
      });
      if (this.fail) {
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: { code: "AUTH", message: "secret" },
          },
        };
        return;
      }
      const prompt = JSON.stringify(options.messages);
      const desc = prompt.includes("解释图片") || prompt.includes("描述图片");
      if (desc) this.descriptionCalls++;
      const text = JSON.stringify({
        transcript: desc
          ? ""
          : n >= 3
            ? "图片末尾目标 target"
            : "图片内文字 alpha",
        description: desc ? "图中结构说明" : "",
      });
      yield { type: "text-delta", index: 0, text };
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      this.active--;
    }
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reader-progressive-")),
    ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LocalAttachments, { dshHome: root });
  await ctx.plugin(FsLocal);
  await ctx.plugin(SubprocessLocal);
  const adapter = new Adapter();
  ctx.llm.registerAdapter(["company"], adapter);
  const config = Config({
    python: { executable: python },
    vision: {
      enabled: true,
      source: "dsh",
      provider: "company",
      model: "vision",
    },
    ocr: { enabled: true },
    progressive: {
      directory: join(root, "durable"),
      batchImages: 2,
      waitMs: 500,
      imageConcurrency: 2,
    },
  });
  const path = join(root, "large.docx");
  execFileSync(python!, [
    "-c",
    String.raw`
from docx import Document
from PIL import Image
import io,sys
p=sys.argv[1];d=Document();d.add_heading('原生标题',1);d.add_paragraph('第一段正文 needle')
images=[]
for color in ['red','green','blue']:
 s=io.BytesIO();Image.new('RGB',(80,80),color).save(s,format='PNG');images.append(s.getvalue())
for n in [0,0,1,2]:
 d.add_paragraph('图前正文 '+str(n));d.add_picture(io.BytesIO(images[n]))
d.add_paragraph('正文结尾 end');d.save(p)
`,
    path,
  ]);
  const exec = {
    callId: ToolCallId("progressive-test"),
    signal: new AbortController().signal,
    agent: { session: { id: "test-session", header: { cwd: root } } },
  } as unknown as ToolExecution;
  let reader = new DocumentReader(ctx, config, () => structuredClone(config));
  return {
    ctx,
    root,
    path,
    config,
    adapter,
    exec,
    get reader() {
      return reader;
    },
    async restart() {
      await reader.dispose();
      reader = new DocumentReader(ctx, config, () => structuredClone(config));
    },
    async close() {
      await reader.dispose();
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function complete(
  f: Awaited<ReturnType<typeof fixture>>,
  args: SearchArgs,
) {
  const pages: SearchValue[] = [];
  for (let n = 0; n < 60; n++) {
    const page = (await f.reader.invoke("search", args, f.exec)) as SearchValue;
    pages.push(page);
    assert.ok(
      Buffer.byteLength(JSON.stringify(page)) <= f.config.search.maxBytes,
    );
    if (!page.next_search_args) return pages;
    args = page.next_search_args;
  }
  throw Error("continuation failed to converge");
}
test(
  "DOCX native-first, bounded OCR batches, dedup, final-image hit, stable reads and restart cache",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      f.adapter.hold = true;
      const first = (await f.reader.invoke(
        "search",
        { file_path: f.path, keywords: ["needle", "target"] },
        f.exec,
      )) as SearchValue;
      assert.ok(
        first.results.some((r) => r.matched_keywords.includes("needle")),
      );
      assert.equal(first.scan_complete, false);
      assert.equal(first.extraction_complete, false);
      assert.equal(first.image_progress?.total, 4);
      const nativeArgs = first.results[0]!.snippets[0]!.read_args;
      const before = (await f.reader.invoke(
        "read",
        nativeArgs,
        f.exec,
      )) as ReadValue;
      // Cancel held work by restarting; successful checkpoints are covered below.
      await f.restart();
      f.adapter.hold = false;
      f.adapter.count = 0;
      const pages = await complete(f, {
        file_path: f.path,
        keywords: ["needle", "target"],
      });
      assert.ok(
        pages
          .flatMap((p) => p.results)
          .some((r) => r.matched_keywords.includes("target")),
      );
      assert.equal(
        f.adapter.count,
        3,
        "four occurrences, three distinct images",
      );
      assert.ok(f.adapter.peak <= 2);
      assert.equal(
        f.adapter.descriptionCalls,
        0,
        "search never generates descriptions",
      );
      assert.equal(pages.at(-1)!.image_progress?.completed, 4);
      assert.equal(pages.at(-1)!.scan_complete, true);
      const after = (await f.reader.invoke(
        "read",
        nativeArgs,
        f.exec,
      )) as ReadValue;
      assert.equal(after.content, before.content);
      const hit = pages
        .flatMap((p) => p.results)
        .find((r) => r.matched_keywords.includes("target"))!;
      const picture = (await f.reader.invoke(
        "read",
        hit.snippets[0]!.read_args,
        f.exec,
      )) as ReadValue;
      assert.match(picture.content, /target/);
      const calls = f.adapter.count;
      await f.restart();
      const restored = await complete(f, {
        file_path: f.path,
        keywords: ["target"],
      });
      assert.equal(f.adapter.count, calls);
      assert.equal(restored.at(-1)!.image_progress?.completed, 4);
      f.config.vision.prompt = "解释图片，新提示词";
      await complete(f, { file_path: f.path, keywords: ["target"] });
      assert.equal(
        f.adapter.count,
        calls,
        "description prompt does not invalidate OCR",
      );
      f.config.progressive.ocrPrompt =
        "新转录提示词，仅返回 transcript 和 description 字符串";
      await complete(f, { file_path: f.path, keywords: ["target"] });
      assert.equal(
        f.adapter.count,
        calls + 3,
        "OCR prompt invalidates only image results",
      );
      let described = (await f.reader.invoke(
        "read",
        { file_path: f.path, image_id: "image:1", image_mode: "description" },
        f.exec,
      )) as ReadValue;
      for (let n = 0; n < 20 && described.next_read_args; n++)
        described = (await f.reader.invoke(
          "read",
          described.next_read_args,
          f.exec,
        )) as ReadValue;
      assert.match(described.content, /图中结构说明/);
      assert.equal(described.visionUsed, true);
      assert.equal(f.adapter.descriptionCalls, 1);
      const afterDescription = f.adapter.count;
      await complete(f, { file_path: f.path, keywords: ["target"] });
      assert.equal(f.adapter.count, afterDescription);
    } finally {
      await f.close();
    }
  },
);
test(
  "text scope does not start OCR; failures are visible and retried by a new query",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const text = await complete(f, {
        file_path: f.path,
        keywords: ["needle"],
        scope: "text",
      });
      assert.equal(f.adapter.count, 0);
      assert.equal(text.at(-1)!.image_progress?.skipped, 4);
      f.adapter.fail = true;
      const failed = await complete(f, {
        file_path: f.path,
        keywords: ["target"],
      });
      assert.equal(failed.at(-1)!.image_progress?.failed, 4);
      assert.equal(failed.at(-1)!.extraction_complete, false);
      f.adapter.fail = false;
      const retry = await complete(f, {
        file_path: f.path,
        keywords: ["target"],
      });
      assert.equal(retry.at(-1)!.image_progress?.failed, 0);
      assert.equal(retry.at(-1)!.image_progress?.completed, 4);
    } finally {
      await f.close();
    }
  },
);

test(
  "inline table ALL combines native/OCR and 4 KiB reads paginate every image handle",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      execFileSync(python!, [
        "-c",
        String.raw`
from docx import Document
from PIL import Image
import io,sys
b=io.BytesIO();Image.new('RGB',(60,60),'red').save(b,format='PNG');data=b.getvalue()
d=Document();row=d.add_table(rows=1,cols=1).rows[0];p=row.cells[0].paragraphs[0];p.add_run('native-combo ');p.add_run().add_picture(io.BytesIO(data))
for n in range(18):d.add_picture(io.BytesIO(data))
d.save(sys.argv[1])
`,
        f.path,
      ]);
      f.config.read.maxBytes = 4096;
      f.config.search.maxBytes = 4096;
      const pages = await complete(f, {
        file_path: f.path,
        keywords: ["native-combo", "alpha"],
        require_all: true,
      });
      assert.ok(
        pages
          .flatMap((p) => p.results)
          .some((r) => r.matched_keywords.length === 2),
      );
      assert.equal(f.adapter.count, 1);
      let read = (await f.reader.invoke(
        "read",
        { file_path: f.path },
        f.exec,
      )) as ReadValue;
      const ids = new Set<string>();
      for (let n = 0; n < 30; n++) {
        assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 4096);
        for (const image of read.images ?? []) ids.add(image.id);
        if (!read.next_images_args) break;
        read = (await f.reader.invoke(
          "read",
          read.next_images_args,
          f.exec,
        )) as ReadValue;
      }
      assert.equal(
        ids.size,
        19,
        "all image handles remain discoverable under small response budgets",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "permission checks survive persistent cache; source edits reuse identical image checkpoints",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const pages = await complete(f, {
        file_path: f.path,
        keywords: ["target"],
      });
      const calls = f.adapter.count;
      const old = pages[0]!.results[0]?.snippets[0]?.read_args;
      const originalRead = f.ctx.fs.readByteRange.bind(f.ctx.fs);
      f.ctx.fs.readByteRange = async () => {
        throw Error("denied test");
      };
      await assert.rejects(
        f.reader.invoke(
          "search",
          { file_path: f.path, keywords: ["target"] },
          f.exec,
        ),
        /denied/,
      );
      f.ctx.fs.readByteRange = originalRead;
      execFileSync(python!, [
        "-c",
        "from docx import Document;import sys;d=Document(sys.argv[1]);d.add_paragraph('修改正文');d.save(sys.argv[1])",
        f.path,
      ]);
      const changed = await complete(f, {
        file_path: f.path,
        keywords: ["修改正文", "target"],
      });
      assert.equal(f.adapter.count, calls);
      assert.ok(
        changed
          .flatMap((p) => p.results)
          .some((r) => r.matched_keywords.includes("修改正文")),
      );
      assert.notEqual(
        changed[0]!.document_revision,
        pages[0]!.document_revision,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "shared native extraction survives cancellation of one waiter",
  { skip: !python, timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const read = f.ctx.fs.readByteRange.bind(f.ctx.fs);
      let entered!: () => void, release!: () => void;
      const seen = new Promise<void>((r) => (entered = r)),
        gate = new Promise<void>((r) => (release = r));
      f.ctx.fs.readByteRange = async (...args) => {
        if (args[1].length > 1) {
          entered();
          await gate;
        }
        return read(...args);
      };
      const controller = new AbortController();
      const first = f.reader.invoke(
        "search",
        { file_path: f.path, keywords: ["needle"], scope: "text" },
        { ...f.exec, signal: controller.signal },
      );
      const firstOutcome = first.then(
        () => "unexpected",
        () => "cancelled",
      );
      const second = f.reader.invoke(
        "search",
        { file_path: f.path, keywords: ["needle"], scope: "text" },
        f.exec,
      );
      await seen;
      controller.abort();
      release();
      assert.equal(await firstOutcome, "cancelled");
      assert.equal(((await second) as SearchValue).results.length, 1);
      assert.equal(f.adapter.count, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "standalone progressive route and corrupted native checkpoint recovery",
  { skip: !python, timeout: 60000 },
  async () => {
    const { createServer } = await import("node:http");
    let calls = 0;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      assert.match(
        parsed.messages[0].content[1].image_url.url,
        /^data:image\/png;base64,/,
      );
      calls++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  transcript: "standalone-needle",
                  description: "",
                }),
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const f = await fixture();
    const name = "DOCUMENT_READER_TEST_STANDALONE_KEY",
      previous = process.env[name];
    process.env[name] = "test-only";
    try {
      f.config.vision.source = "standalone";
      f.config.vision.baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      f.config.vision.apiKeyEnv = name;
      const direct = (await f.reader.invoke(
        "read",
        {
          file_path: f.path,
          image_id: "image:4",
          image_mode: "transcription",
        },
        f.exec,
      )) as ReadValue;
      assert.equal(direct.images?.[0]?.status, "done");
      assert.equal(calls, 1);
      const pages = await complete(f, {
        file_path: f.path,
        keywords: ["standalone-needle"],
      });
      assert.equal(calls, 3);
      assert.equal(pages.at(-1)!.image_progress?.completed, 4);
      const dirs = (await readdir(f.config.progressive.directory)).filter((n) =>
        n.endsWith(".doc"),
      );
      await writeFile(
        join(f.config.progressive.directory, dirs[0]!, "body.bin"),
        "corrupt checkpoint",
      );
      await f.restart();
      const restored = await complete(f, {
        file_path: f.path,
        keywords: ["needle"],
      });
      assert.ok(restored.flatMap((p) => p.results).length);
      assert.equal(calls, 3, "OCR checkpoints survive native reparse");
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
      await f.close();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  },
);

async function until(check: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for model call");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
for (const batchImages of [2, 3])
  test(
    `synchronous image read bypasses busy background (${batchImages === 2 ? "outside batch" : "already queued"}), shares requests and caches results`,
    { skip: !python, timeout: 120000 },
    async () => {
      const f = await fixture();
      try {
        f.config.progressive.imageConcurrency = 1;
        f.config.progressive.batchImages = batchImages;
        f.config.progressive.waitMs = 1;
        f.adapter.controlled = true;
        await f.reader.invoke(
          "search",
          { file_path: f.path, keywords: ["needle"] },
          f.exec,
        );
        await until(() => f.adapter.gates.has(1));
        const args = {
          file_path: f.path,
          image_id: "image:4",
          image_mode: "transcription" as const,
        };
        let returned = false;
        const first = f.reader.invoke("read", args, f.exec).then((v) => {
          returned = true;
          return v as ReadValue;
        });
        await until(() => f.adapter.gates.has(2)); // no release of the occupied background slot
        const duplicate = f.reader.invoke("read", args, f.exec);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(
          returned,
          false,
          "waitMs must not cause a pending response",
        );
        assert.equal(
          f.adapter.count,
          2,
          "explicit callers share one foreground request",
        );
        f.adapter.gates.get(2)!();
        const value = await first;
        await duplicate;
        assert.equal(value.images?.[0]?.status, "done");
        assert.match(value.content, /图片内文字 alpha/);
        assert.equal(value.next_read_args, null);
        assert.equal(f.adapter.active, 1, "background call remains blocked");
        await f.reader.invoke("read", args, f.exec);
        assert.equal(f.adapter.count, 2, "memory cache hit");
        f.adapter.gates.get(1)!();
        await until(() => f.adapter.gates.has(3));
        f.adapter.gates.get(3)!();
        const pages = await complete(f, {
          file_path: f.path,
          keywords: ["target"],
        });
        assert.equal(pages.at(-1)?.image_progress?.completed, 4);
        assert.equal(
          f.adapter.count,
          3,
          "search reuses foreground result instead of parsing again",
        );
        assert.equal(
          f.adapter.peak,
          2,
          "foreground is independent of the single background slot",
        );
        await f.restart();
        await f.reader.invoke("read", args, f.exec);
        assert.equal(f.adapter.count, 3, "persistent cache survives restart");
      } finally {
        await f.close();
      }
    },
  );
test(
  "synchronous description bypasses a saturated transcription queue",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      f.config.progressive.imageConcurrency = 1;
      f.config.progressive.waitMs = 1;
      f.adapter.controlled = true;
      await f.reader.invoke(
        "search",
        { file_path: f.path, keywords: ["needle"] },
        f.exec,
      );
      await until(() => f.adapter.gates.has(1));
      const reading = f.reader.invoke(
        "read",
        { file_path: f.path, image_id: "image:4", image_mode: "description" },
        f.exec,
      );
      await until(() => f.adapter.gates.has(2));
      f.adapter.gates.get(2)!();
      const value = (await reading) as ReadValue;
      assert.match(value.content, /图中结构说明/);
      assert.equal(value.images?.[0]?.status, "done");
      assert.equal(f.adapter.descriptionCalls, 1);
      assert.equal(f.adapter.active, 1);
    } finally {
      await f.close();
    }
  },
);
test(
  "direct read takes over its running background image without waiting for its completion",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      f.config.progressive.imageConcurrency = 1;
      f.config.progressive.batchImages = 1;
      f.adapter.controlled = true;
      await f.reader.invoke(
        "search",
        { file_path: f.path, keywords: ["needle"] },
        f.exec,
      );
      await until(() => f.adapter.gates.has(1));
      const reading = f.reader.invoke(
        "read",
        { file_path: f.path, image_id: "image:1", image_mode: "transcription" },
        f.exec,
      );
      await until(() => f.adapter.gates.has(2));
      assert.deepEqual(f.adapter.cancelled, [1]);
      f.adapter.gates.get(2)!();
      const value = (await reading) as ReadValue;
      assert.equal(value.images?.[0]?.status, "done");
      assert.equal(value.image_progress?.failed, 0);
      await f.reader.invoke(
        "read",
        { file_path: f.path, image_id: "image:2", image_mode: "transcription" },
        f.exec,
      );
      assert.equal(
        f.adapter.count,
        2,
        "duplicate image occurrence shares successful cache",
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "foreground failure is explicit, retries work and cancelling one caller preserves other callers and background",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      f.config.progressive.imageConcurrency = 1;
      f.adapter.controlled = true;
      await f.reader.invoke(
        "search",
        { file_path: f.path, keywords: ["needle"] },
        f.exec,
      );
      await until(() => f.adapter.gates.has(1));
      const args = {
        file_path: f.path,
        image_id: "image:4",
        image_mode: "description" as const,
      };
      const abort = new AbortController();
      const cancelled = f.reader.invoke("read", args, {
        ...f.exec,
        signal: abort.signal,
      });
      const rejection = assert.rejects(cancelled, /DOCUMENT_CANCELLED/);
      await until(() => f.adapter.gates.has(2));
      const remaining = f.reader.invoke("read", args, f.exec);
      await new Promise((r) => setTimeout(r, 50));
      abort.abort();
      await rejection;
      assert.equal(f.adapter.active, 2);
      f.adapter.fail = true;
      const failure = assert.rejects(remaining, /指定图片解析失败/);
      f.adapter.gates.get(2)!();
      await failure;
      assert.equal(f.adapter.active, 1);
      f.adapter.fail = false;
      const retry = f.reader.invoke("read", args, f.exec);
      await until(() => f.adapter.gates.has(3));
      f.adapter.gates.get(3)!();
      const value = (await retry) as ReadValue;
      assert.equal(value.images?.[0]?.status, "done");
      assert.match(value.content, /图中结构说明/);
      const originalRead = f.ctx.fs.readByteRange.bind(f.ctx.fs);
      f.ctx.fs.readByteRange = async () => {
        throw Error("denied direct test");
      };
      await assert.rejects(
        f.reader.invoke("read", args, f.exec),
        /denied direct test/,
      );
      f.ctx.fs.readByteRange = originalRead;
      await f.reader.invoke("read", args, f.exec);
      assert.equal(f.adapter.count, 3);
      // Last caller cancellation aborts only its own image and leaves the background alive.
      const stop = new AbortController();
      const last = f.reader.invoke(
        "read",
        { ...args, image_id: "image:3" },
        { ...f.exec, signal: stop.signal },
      );
      const stopped = assert.rejects(last, /DOCUMENT_CANCELLED/);
      await until(() => f.adapter.gates.has(4));
      stop.abort();
      await stopped;
      await until(() => f.adapter.cancelled.includes(4));
      assert.equal(f.adapter.active, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "synchronous image result remains available through snapshot pagination without processing siblings",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      execFileSync(python!, [
        "-c",
        String.raw`
from docx import Document
from PIL import Image
import io,sys
d=Document();cell=d.add_table(rows=1,cols=1).cell(0,0);p=cell.paragraphs[0];p.add_run('long native text '*400)
for color in ['red','blue']:
 b=io.BytesIO();Image.new('RGB',(80,80),color).save(b,format='PNG');p.add_run().add_picture(io.BytesIO(b.getvalue()))
d.save(sys.argv[1])
`,
        f.path,
      ]);
      f.config.read.maxBytes = 4096;
      f.adapter.controlled = true;
      f.config.progressive.waitMs = 30;
      const reading = f.reader.invoke(
        "read",
        {
          file_path: f.path,
          image_id: "image:2",
          image_mode: "transcription",
          limit: 1,
        },
        f.exec,
      );
      await until(() => f.adapter.gates.has(1));
      f.adapter.gates.get(1)!();
      let value = (await reading) as ReadValue;
      let content = value.content;
      assert.equal(value.images?.[0]?.status, "done");
      assert.ok(
        value.next_read_args?.cursor,
        "native block should require snapshot pagination",
      );
      for (let n = 0; n < 50 && value.next_read_args?.cursor; n++) {
        value = (await f.reader.invoke(
          "read",
          value.next_read_args,
          f.exec,
        )) as ReadValue;
        content += value.content;
      }
      assert.match(content, /图片内文字 alpha/);
      assert.equal(value.images?.length, 1);
      assert.equal(value.images?.[0]?.id, "image:2");
      assert.equal(value.images?.[0]?.status, "done");
      assert.equal(value.next_read_args, null);
      assert.equal(f.adapter.count, 1, "unrequested sibling is not parsed");
    } finally {
      await f.close();
    }
  },
);

test(
  "direct image timeout and disposal reject without a pending result; disabled mode does not call a model",
  { skip: !python, timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      await f.reader.invoke("read", { file_path: f.path }, f.exec);
      const args = {
        file_path: f.path,
        image_id: "image:1",
        image_mode: "description" as const,
      };
      f.config.vision.enabled = false;
      await assert.rejects(
        f.reader.invoke("read", args, f.exec),
        /DOCUMENT_VISION_DISABLED/,
      );
      assert.equal(f.adapter.count, 0);
      f.config.vision.enabled = true;
      f.config.vision.requestTimeoutMs = 30;
      f.config.vision.maxRetries = 0;
      f.adapter.hold = true;
      await assert.rejects(f.reader.invoke("read", args, f.exec), /TIMEOUT/);
      assert.equal(f.adapter.active, 0);
      f.config.vision.requestTimeoutMs = 60000;
      f.adapter.hold = false;
      f.adapter.controlled = true;
      const read = f.reader.invoke("read", args, f.exec);
      const rejected = assert.rejects(read, /DOCUMENT_CANCELLED/);
      await until(() => f.adapter.gates.has(2));
      await f.reader.dispose();
      await rejected;
      assert.equal(f.adapter.active, 0);
    } finally {
      await f.close();
    }
  },
);
