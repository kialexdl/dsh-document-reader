/** Deterministic local performance fixture; never sends documents to a real endpoint. */
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Config } from "../src/config.js";
import { DocumentReader } from "../src/tool.js";
import type { SearchValue, SearchArgs } from "../src/types.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
const python = process.env.DOCUMENT_READER_TEST_PYTHON;
if (!python)
  throw Error(
    "Set DOCUMENT_READER_TEST_PYTHON to the tested Python executable",
  );
class Fake extends LlmAdapter {
  calls = 0;
  async listModels(provider: string) {
    return [
      {
        provider,
        id: "fixture",
        name: "fixture",
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
    this.calls++;
    await new Promise((r) => setTimeout(r, 100));
    options.signal?.throwIfAborted();
    yield {
      type: "text-delta",
      index: 0,
      text: JSON.stringify({ transcript: "图片目标 needle", description: "" }),
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
const root = await mkdtemp(join(tmpdir(), "reader-benchmark-")),
  path = join(root, "large.docx"),
  ctx = new Context();
let reader: DocumentReader | undefined;
try {
  execFileSync(python, [
    "-c",
    String.raw`
from docx import Document
from PIL import Image
import io,sys
D=Document();D.add_paragraph('needle 第一段正文')
for n in range(5000):D.add_paragraph('架构说明和故障定位相关内容，段落编号 '+str(n))
images=[]
for n in range(6):
 b=io.BytesIO();Image.new('RGB',(800,600),(n*35,80,120)).save(b,format='PNG');images.append(b.getvalue())
for n in range(60):D.add_picture(io.BytesIO(images[n%6]))
D.save(sys.argv[1])
`,
    path,
  ]);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LocalAttachments, { dshHome: root });
  await ctx.plugin(FsLocal);
  await ctx.plugin(SubprocessLocal);
  const fake = new Fake();
  ctx.llm.registerAdapter(["test"], fake);
  const config = Config({
    python: { executable: python },
    vision: {
      source: "dsh",
      provider: "test",
      model: "fixture",
      maxCallsPerDocument: 200,
    },
    ocr: { enabled: true },
    progressive: { directory: join(root, "durable"), waitMs: 1000 },
  });
  const exec = {
    callId: ToolCallId("benchmark"),
    signal: new AbortController().signal,
    agent: { session: { id: "benchmark", header: { cwd: root } } },
  } as unknown as ToolExecution;
  const metrics: any = {
    paragraphs: 5001,
    imageOccurrences: 60,
    uniqueImages: 6,
    simulatedModelDelayMs: 100,
  };
  for (const enabled of [false, true]) {
    config.progressive.enabled = enabled;
    reader = new DocumentReader(ctx, config);
    const calls = fake.calls;
    const start = performance.now();
    let page = (await reader.invoke(
      "search",
      { file_path: path, keywords: ["needle"] },
      exec,
    )) as SearchValue;
    const first = performance.now() - start;
    let responses = 1;
    while (page.next_search_args) {
      page = (await reader.invoke(
        "search",
        page.next_search_args,
        exec,
      )) as SearchValue;
      responses++;
      if (responses > 300) throw Error("nonconvergent");
    }
    metrics[enabled ? "progressive" : "legacy"] = {
      firstResponseMs: Math.round(first),
      allResultsMs: Math.round(performance.now() - start),
      modelCalls: fake.calls - calls,
      responses,
    };
    await reader.dispose();
    reader = undefined;
  }
  reader = new DocumentReader(ctx, config);
  const calls = fake.calls,
    start = performance.now();
  let page = (await reader.invoke(
    "search",
    { file_path: path, keywords: ["needle"] },
    exec,
  )) as SearchValue;
  const first = performance.now() - start;
  while (page.next_search_args)
    page = (await reader.invoke(
      "search",
      page.next_search_args,
      exec,
    )) as SearchValue;
  metrics.afterRestart = {
    firstResponseMs: Math.round(first),
    allResultsMs: Math.round(performance.now() - start),
    modelCalls: fake.calls - calls,
  };
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  await reader?.dispose();
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
