import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, {
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import LocalAttachments from "@deepseek-ai/dsh-attachment-local";
import {
  Config,
  PluginConfig,
  snapshotConfig,
  visionSource,
} from "../src/config.js";
import { DshVision } from "../src/vision.js";
import {
  visualGroups,
  selectedAvailable,
} from "../src/client/model-options.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DocumentReader } from "../src/tool.js";
import FsLocal from "@deepseek-ai/dsh-fs-local";
import SubprocessLocal from "@deepseek-ai/dsh-subprocess-local";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGP8//8/AymAiSTVoxpGNQwpDQBVbQMdPVIhQwAAAABJRU5ErkJggg==",
  "base64",
);
class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = [];
  failure?: string;
  images = true;
  delay = false;
  async listModels(provider: string) {
    return [
      {
        provider,
        id: "vision-a",
        name: "Vision A",
        inputModalities: this.images
          ? (["text", "image"] as const)
          : (["text"] as const),
      },
      {
        provider,
        id: "vision-b",
        name: "Vision B",
        inputModalities: ["text", "image"] as const,
      },
    ];
  }
  async resolveModel(provider: string, id: string) {
    return {
      provider,
      id,
      name: id,
      inputModalities: this.images
        ? (["text", "image"] as const)
        : (["text"] as const),
    };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    if (this.delay) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        options.signal!.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(options.signal!.reason);
          },
          { once: true },
        );
      });
    }
    if (this.failure) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            code: this.failure,
            message: "secret endpoint error MUST NOT ESCAPE",
          },
        },
      };
      return;
    }
    const text = JSON.stringify({
      transcript: "图片文字 " + options.model,
      description: "图片说明",
    });
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reader-vision-")),
    ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LocalAttachments, { dshHome: root });
  const adapter = new Adapter();
  ctx.llm.registerAdapter(["company"], adapter);
  const config = Config({
    vision: {
      source: "dsh",
      provider: "company",
      model: "vision-a",
      enabled: true,
    },
    ocr: { enabled: true },
  });
  return {
    ctx,
    root,
    adapter,
    config,
    async close() {
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("live schema snapshots and legacy source migration preserve selection", () => {
  assert.equal(visionSource(Config({})), "dsh");
  assert.equal(
    visionSource(Config({ vision: { baseURL: "https://legacy.example/v1" } })),
    "standalone",
  );
  const live = PluginConfig({
    vision: { source: "dsh", provider: "company", model: "vision-a" },
  });
  assert.equal(snapshotConfig(live).vision.provider, "company");
  assert.equal(Config({}).vision.enabled, false);
});
test("visual catalog excludes text-only and unknown, retains empty provider", () => {
  const rows = visualGroups([
    {
      id: "company",
      name: "公司",
      models: [
        { id: "a", name: "A", inputModalities: ["image"] },
        { id: "b", name: "B", inputModalities: ["text"] },
        { id: "c", name: "C" },
      ],
    },
  ]);
  assert.deepEqual(
    rows[0]!.models.map((m) => m.id),
    ["a"],
  );
  assert.equal(selectedAvailable(rows, "company", "b"), false);
});
test("real DSH LLM and attachment services receive exact explicit route and image, no duplicate text", async () => {
  const f = await fixture();
  try {
    const v = new DshVision(f.ctx, f.config.vision);
    await v.preflight(new AbortController().signal);
    const result = await v.analyze(
      png,
      "image/png",
      "transcribe",
      new AbortController().signal,
    );
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(result.text!).transcript, "图片文字 vision-a");
    assert.equal(f.adapter.calls[0]!.provider, "company");
    assert.equal(f.adapter.calls[0]!.model, "vision-a");
    const block = f.adapter.calls[0]!.messages[0]!.content[1]!;
    assert.equal(block.type, "image");
    if (block.type === "image")
      assert.ok(
        (await f.ctx.attachments.readImage(block.attachment)).data.length,
      );
  } finally {
    await f.close();
  }
});
test("capability is rechecked at dispatch and route changes fail closed", async () => {
  const f = await fixture();
  try {
    const v = new DshVision(f.ctx, f.config.vision);
    await v.preflight(new AbortController().signal);
    f.adapter.images = false;
    await assert.rejects(
      v.analyze(png, "image/png", "x", new AbortController().signal),
      /不再支持图片/,
    );
    assert.equal(f.adapter.calls.length, 0);
    await assert.rejects(
      new DshVision(f.ctx, f.config.vision, undefined, () => false).analyze(
        png,
        "image/png",
        "x",
        new AbortController().signal,
      ),
      /配置发生变化/,
    );
  } finally {
    await f.close();
  }
});
test("auth failures sanitized, retry budget counts attempts, timeout and cancellation settle", async () => {
  const f = await fixture();
  try {
    f.adapter.failure = "AUTH";
    assert.deepEqual(
      await new DshVision(f.ctx, f.config.vision).analyze(
        png,
        "image/png",
        "x",
        new AbortController().signal,
      ),
      { ok: false, code: "AUTH" },
    );
    assert.equal(f.adapter.calls.length, 1);
    f.adapter.failure = "RATE_LIMIT";
    f.config.vision.maxRetries = 5;
    f.config.vision.maxCallsPerDocument = 2;
    assert.deepEqual(
      await new DshVision(f.ctx, f.config.vision).analyze(
        png,
        "image/png",
        "x",
        new AbortController().signal,
      ),
      { ok: false, code: "VISION_CALL_LIMIT" },
    );
    assert.equal(f.adapter.calls.length, 3);
    f.adapter.failure = undefined;
    f.adapter.delay = true;
    f.config.vision.maxRetries = 0;
    f.config.vision.requestTimeoutMs = 30;
    assert.equal(
      (
        await new DshVision(f.ctx, f.config.vision).analyze(
          png,
          "image/png",
          "x",
          new AbortController().signal,
        )
      ).code,
      "TIMEOUT",
    );
    const c = new AbortController();
    setTimeout(() => c.abort(), 20);
    await assert.rejects(
      new DshVision(f.ctx, f.config.vision).analyze(
        png,
        "image/png",
        "x",
        c.signal,
      ),
    );
  } finally {
    await f.close();
  }
});
test(
  "real Python pipe → DSH visual route; changed config invalidates cached content",
  { skip: !process.env.DOCUMENT_READER_TEST_PYTHON, timeout: 30000 },
  async () => {
    const f = await fixture();
    let reader: DocumentReader | undefined;
    try {
      await f.ctx.plugin(FsLocal);
      await f.ctx.plugin(SubprocessLocal);
      f.config.python.executable = process.env.DOCUMENT_READER_TEST_PYTHON!;
      const path = join(f.root, "picture.png");
      await writeFile(path, png);
      reader = new DocumentReader(f.ctx, f.config, () =>
        structuredClone(f.config),
      );
      // Keep a session identity for cache reuse; the tool execution's FS policy remains real.
      const exec = {
        callId: ToolCallId("vision-test"),
        signal: new AbortController().signal,
        agent: {
          options: { cwd: f.root },
          session: { id: "vision-session", header: { cwd: f.root } },
        },
      } as unknown as ToolExecution;
      const first = await reader.invoke("read", { file_path: path }, exec);
      assert.equal(first.ocrUsed, true);
      assert.equal(first.visionUsed, true);
      assert.equal(first.partial, false);
      assert.equal(f.adapter.calls.length, 1);
      await reader.invoke("read", { file_path: path }, exec);
      assert.equal(f.adapter.calls.length, 1);
      f.config.vision.model = "vision-b";
      await assert.rejects(
        reader.invoke(
          "read",
          { file_path: path, expected_revision: first.document_revision },
          exec,
        ),
        /过期|版本|失效/,
      );
      const second = await reader.invoke("read", { file_path: path }, exec);
      assert.notEqual(first.document_revision, second.document_revision);
      assert.equal(f.adapter.calls.length, 2);
      assert.equal(f.adapter.calls[1]!.model, "vision-b");
    } finally {
      await reader?.dispose();
      await f.close();
    }
  },
);
