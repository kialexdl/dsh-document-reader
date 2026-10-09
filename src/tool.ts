/** Tool orchestration: one conversion per session/source/config, with shared cancellation. */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-session";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateConfig, visionSource, type Config } from "./config.js";
import { DshVision } from "./vision.js";
import { Cache } from "./cache.js";
import type { Entry } from "./cache.js";
import { ProgressiveReader } from "./progressive.js";
import { PythonBridge } from "./python.js";
import { resolveSource } from "./security.js";
import { aborted, fail } from "./errors.js";
import type { ReadArgs, SearchArgs, ReadValue, SearchValue } from "./types.js";
import { readWindow } from "./read.js";
import type { ReadState } from "./read.js";
import { search, searchInput } from "./search.js";
import type { SearchState } from "./search.js";
interface Flight {
  controller: AbortController;
  promise: Promise<Entry>;
  waiters: number;
  session: string;
}
export class DocumentReader {
  readonly cache: Cache;
  private readonly python: PythonBridge;
  private readonly progressive: ProgressiveReader;
  private readonly flights = new Map<string, Flight>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private modelEpoch = 0;
  invalidateModels(): void {
    this.modelEpoch++;
    this.progressive.invalidate();
  }
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private readonly ctx: Context,
    readonly config: Config,
    private readonly readConfig: () => Config = () => config,
  ) {
    this.cache = new Cache(config, async (directory) => {
      if (process.platform !== "win32") return;
      const executable =
        await ctx.subprocess.resolveExecutable("powershell.exe");
      const child = ctx.subprocess.spawn({
        argv: [
          executable,
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          fileURLToPath(new URL("../scripts/secure-temp.ps1", import.meta.url)),
          "-Directory",
          directory,
        ],
        cwd: directory,
        graceMs: config.python.terminateGraceMs,
        signal: AbortSignal.timeout(config.python.startupTimeoutMs),
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
      });
      try {
        if ((await child.done).exitCode !== 0)
          fail(
            "DOCUMENT_TEMP_PERMISSION",
            "无法建立仅当前用户可读写的临时目录。",
          );
      } finally {
        child.terminate();
        await child.waitForExit();
      }
    });
    this.python = new PythonBridge(ctx, config, this.cache);
    this.progressive = new ProgressiveReader(
      ctx,
      this.cache,
      this.python,
      () => this.flights.size,
    );
    this.cache.readConfig = readConfig;
    this.refreshConfig();
  }
  refreshConfig(): void {
    clearTimeout(this.timer);
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      const work = this.cache.sweep().then(() => this.progressive.sweep());
      this.track(work);
      work.catch(() =>
        this.ctx.logger.warn("文档缓存清理失败，将在下一次尝试。"),
      );
      this.refreshConfig();
    }, this.readConfig().cache.sweepIntervalSeconds * 1000);
    this.timer.unref();
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    promise.then(
      () => this.active.delete(promise),
      () => this.active.delete(promise),
    );
    return promise;
  }
  invoke(
    kind: "read" | "search",
    args: ReadArgs | SearchArgs,
    exec: ToolExecution,
  ): Promise<ReadValue | SearchValue> {
    return this.track(
      this.run(kind, args, {
        ...exec,
        signal: AbortSignal.any([exec.signal, this.lifetime.signal]),
      }),
    );
  }
  private async run(
    kind: "read" | "search",
    args: ReadArgs | SearchArgs,
    exec: ToolExecution,
  ): Promise<ReadValue | SearchValue> {
    const config = validateConfig(this.readConfig());
    const epoch = this.modelEpoch;
    const fingerprint = JSON.stringify({
      python: config.python,
      conversion: config.conversion,
      vision: config.vision,
      ocr: config.ocr,
      epoch: visionSource(config) === "dsh" ? epoch : 0,
      adapter: 2,
    });
    if (this.disposed) fail("DOCUMENT_CANCELLED", "插件已停止。");
    aborted(exec.signal);
    if (!args || typeof args !== "object")
      fail("DOCUMENT_ARGUMENT_INVALID", "参数必须为对象。");
    const allowed = args.cursor
      ? ["file_path", "cursor"]
      : kind === "read"
        ? [
            "file_path",
            "offset",
            "limit",
            "expected_revision",
            "image_offset",
            "image_id",
            "block_id",
            "image_mode",
          ]
        : ["file_path", "keywords", "require_all", "scope"];
    if (Object.keys(args).some((k) => !allowed.includes(k)))
      fail(
        "DOCUMENT_ARGUMENT_INVALID",
        args.cursor
          ? "续查仅接受 file_path 与 cursor，请复制 next_*_args。"
          : "存在不支持的参数，请按工具说明调用。",
      );
    if ("cursor" in args && (typeof args.cursor !== "string" || !args.cursor))
      fail("DOCUMENT_CURSOR_INVALID", "cursor 必须从工具结果原样复制。");
    // Validate queries before reading/converting a document.
    const initial =
      kind === "search" && !args.cursor
        ? searchInput(args as SearchArgs, this.cache)
        : undefined;
    if (kind === "read" && !args.cursor) {
      const a = args as ReadArgs;
      if (
        (a.offset !== undefined &&
          (!Number.isInteger(a.offset) || a.offset < 1)) ||
        (a.limit !== undefined &&
          (!Number.isInteger(a.limit) ||
            a.limit < 1 ||
            a.limit > config.read.maxLines)) ||
        (a.expected_revision !== undefined &&
          typeof a.expected_revision !== "string")
      )
        fail(
          "DOCUMENT_ARGUMENT_INVALID",
          "offset/limit 必须为配置范围内的正整数，expected_revision 必须是工具返回的字符串。",
        );
    }
    const { target, info, format } = await resolveSource(
      this.ctx,
      exec,
      args.file_path,
    );
    if (format === "docx" && config.progressive.enabled) {
      if (
        "scope" in args &&
        args.scope !== undefined &&
        !["all", "text"].includes(args.scope)
      )
        fail("DOCUMENT_ARGUMENT_INVALID", "scope 只支持 all 或 text。");
      if (kind === "read") {
        const a = args as ReadArgs;
        if (
          (a.image_offset !== undefined &&
            (!Number.isSafeInteger(a.image_offset) ||
              a.image_offset < 0 ||
              !!a.image_id ||
              !!a.block_id)) ||
          (a.image_id && a.block_id) ||
          (a.image_mode &&
            !["transcription", "description"].includes(a.image_mode)) ||
          (a.image_id !== undefined &&
            (typeof a.image_id !== "string" ||
              !/^image:\d+$/.test(a.image_id))) ||
          (a.block_id !== undefined &&
            (typeof a.block_id !== "string" || !/^block:\d+$/.test(a.block_id)))
        )
          fail(
            "DOCUMENT_ARGUMENT_INVALID",
            "图片或块定位参数无效，请复制工具返回的 read_args。",
          );
      }
      return this.progressive.invoke(kind, args, exec, target, info, config);
    }
    if (
      ("scope" in args && args.scope !== undefined) ||
      "image_offset" in args ||
      "image_id" in args ||
      "block_id" in args ||
      "image_mode" in args
    )
      fail(
        "DOCUMENT_ARGUMENT_INVALID",
        "范围和图片定位参数当前仅适用于启用渐进处理的 DOCX。",
      );
    const session = exec.agent?.session.id ?? "call:" + randomUUID();
    const key = createHash("sha256")
      .update(
        JSON.stringify([session, target.targetKey, info.version, fingerprint]),
      )
      .digest("hex");
    const cursor = args.cursor
      ? this.cache.getCursor(args.cursor, session, key, kind)
      : undefined;
    const expected =
      cursor?.revision ??
      ("expected_revision" in args ? args.expected_revision : undefined);
    let entry = await this.cache.acquire(key, expected);
    try {
      if (!entry) {
        let flight = this.flights.get(key);
        if (!flight) {
          if (
            this.flights.size + this.progressive.activeConversions >=
            config.conversion.maxConcurrent
          )
            fail("DOCUMENT_BUSY", "转换任务已满，请稍后重试。");
          const controller = new AbortController();
          const approve = async (bytes: number) => {
            aborted(controller.signal);
            const approval = this.ctx.get("approval");
            if (!approval || !exec.agent)
              fail(
                "DOCUMENT_LIMIT_EXCEEDED",
                "结果超过普通缓存配额，需要 DSH 审批服务及活动会话。",
              );
            const outcome = await approval.request({
              agent: exec.agent,
              callId: exec.callId,
              toolName: kind === "read" ? "read_document" : "search_document",
              reason: `本次文档读取需要最多 ${Math.ceil(bytes / 1024 / 1024)} MiB 临时配额（普通配额 ${config.cache.maxTotalMiB} MiB）。是否仅允许本次？`,
              signal: controller.signal,
            });
            if (outcome !== "allowed-once")
              fail("DOCUMENT_LIMIT_EXCEEDED", "本次超额读取未获批准。");
          };
          const vision =
            (config.vision.enabled || config.ocr.enabled) &&
            visionSource(config) === "dsh"
              ? new DshVision(
                  this.ctx,
                  config.vision,
                  exec.agent?.session,
                  () => this.modelEpoch === epoch,
                )
              : undefined;
          const promise = this.python.convert(
            {
              key,
              session,
              file: target.displayPath,
              format,
              target,
              info,
              signal: controller.signal,
              config,
              vision,
            },
            approve,
          );
          flight = { controller, promise, waiters: 0, session };
          this.flights.set(key, flight);
          promise.finally(() => this.flights.delete(key)).catch(() => {});
        }
        flight.waiters++;
        let onAbort: () => void = () => {};
        try {
          await Promise.race([
            flight.promise,
            new Promise<never>((_, reject) => {
              onAbort = () => reject(new Error("cancelled"));
              exec.signal.addEventListener("abort", onAbort, { once: true });
              if (exec.signal.aborted) onAbort();
            }),
          ]);
          aborted(exec.signal);
          entry = await this.cache.acquire(key);
          if (!entry) fail("DOCUMENT_REVISION_EXPIRED", "缓存已过期，请重试。");
        } catch (error) {
          aborted(exec.signal);
          throw error;
        } finally {
          exec.signal.removeEventListener("abort", onAbort);
          if (--flight.waiters === 0 && !this.cache.entries.has(key))
            flight.controller.abort();
        }
      }
      const value =
        kind === "read"
          ? await readWindow(
              this.cache,
              entry,
              args as ReadArgs,
              cursor?.state as ReadState | undefined,
            )
          : await search(
              this.cache,
              entry,
              (cursor?.state as SearchState | undefined) ?? initial!,
              exec.signal,
            );
      aborted(exec.signal);
      // Recheck read authority before publishing a potentially long-running conversion/search.
      await this.ctx.fs.readByteRange(
        target,
        { offset: 0, length: 1 },
        exec.signal,
      );
      if (
        (await this.ctx.fs.stat(target, exec.signal))?.version !== info.version
      )
        fail("DOCUMENT_CHANGED", "源文件变化，请重新搜索或读取。");
      this.ctx.emit(
        "fs/observed",
        target,
        { kind: "present", version: info.version },
        exec,
      );
      return value;
    } finally {
      if (entry) await this.cache.unpin(entry);
      if (!exec.agent) await this.cache.sweep(session);
    }
  }
  disposeSession(session: string): void {
    for (const f of this.flights.values())
      if (f.session === session) f.controller.abort();
    const cleanup = this.progressive
      .sweep(session)
      .then(() => this.cache.sweep(session));
    this.track(cleanup);
    cleanup.catch(() => this.ctx.logger.warn("文档会话缓存清理失败。"));
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.timer);
    this.lifetime.abort();
    for (const f of this.flights.values()) f.controller.abort();
    await Promise.allSettled([
      ...this.active,
      ...[...this.flights.values()].map((f) => f.promise),
    ]);
    await this.progressive.dispose();
    await this.python.dispose();
    await this.cache.dispose();
  }
}
const str = { type: "string", required: true } as const;
const num = { type: "integer", required: true } as const;
const bool = { type: "boolean", required: true } as const;
const nullableNumber = {
  oneOf: [{ type: "integer" }, { type: "null" }],
  required: true,
} as const;
const location = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: str,
    page: { type: "integer" },
    slide: { type: "integer" },
    sheet: { type: "string" },
    record: { type: "integer" },
    block: { type: "string" },
    heading: { type: "array", items: { type: "string" } },
    part: { type: "string" },
    hidden: { type: "boolean" },
  },
} as const;
const readArgs = {
  type: "object",
  additionalProperties: false,
  properties: {
    file_path: str,
    offset: { type: "integer" },
    limit: { type: "integer" },
    expected_revision: { type: "string" },
    image_offset: { type: "integer" },
    image_id: { type: "string" },
    block_id: { type: "string" },
    image_mode: { type: "string" },
    cursor: { type: "string" },
  },
} as const;
const searchArgs = {
  type: "object",
  additionalProperties: false,
  properties: { file_path: str, cursor: str },
} as const;
const common = {
  file: str,
  format: str,
  document_revision: str,
  partial: bool,
  warnings: { type: "array", items: { type: "string" }, required: true },
  extraction_coverage: str,
} as const;
const imageProgress = {
  type: "object",
  additionalProperties: false,
  properties: {
    total: num,
    completed: num,
    failed: num,
    pending: num,
    skipped: num,
    running: bool,
  },
} as const;
const readOutput = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...common,
    image_progress: imageProgress,
    next_images_args: { oneOf: [readArgs, { type: "null" }] },
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: str,
          block_id: str,
          status: str,
          read_args: { ...readArgs, required: true },
        },
      },
    },
    offset: num,
    returnedLines: num,
    totalLines: num,
    nextOffset: nullableNumber,
    eof: bool,
    content: str,
    locations: { type: "array", items: location, required: true },
    line_fragment: bool,
    fragment_start_byte: nullableNumber,
    next_read_args: { oneOf: [readArgs, { type: "null" }], required: true },
    visionUsed: bool,
    ocrUsed: bool,
  },
} as const;
const snippet = {
  type: "object",
  additionalProperties: false,
  properties: {
    location: { ...location, required: true },
    keyword: str,
    source: str,
    start_line: num,
    end_line: num,
    text: str,
    read_args: { ...readArgs, required: true },
  },
} as const;
const searchOutput = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...common,
    image_progress: imageProgress,
    extraction_complete: { type: "boolean" },
    search_scope: { type: "string" },
    effective_scope: str,
    keywords: { type: "array", items: { type: "string" }, required: true },
    require_all: bool,
    results: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          location: { ...location, required: true },
          result_id: { type: "string" },
          update: { type: "boolean" },
          matched_keywords: {
            type: "array",
            items: { type: "string" },
            required: true,
          },
          snippets: { type: "array", items: snippet, required: true },
          snippets_truncated: bool,
        },
      },
    },
    scan_complete: bool,
    has_more: {
      oneOf: [{ type: "boolean" }, { type: "null" }],
      required: true,
    },
    next_search_args: { oneOf: [searchArgs, { type: "null" }], required: true },
    excluded_content: {
      type: "array",
      items: { type: "string" },
      required: true,
    },
  },
} as const;
export function registerTools(ctx: Context, reader: DocumentReader): void {
  ctx.tools.register(
    defineTool({
      name: "read_document",
      description:
        "读取 PDF/DOCX/PPTX/XLSX/XLS/CSV/PNG/JPEG。offset 是转换文本行号，不是 Word 页码。需要更多内容时原样复制 next_read_args。eof 只表示转换文本末尾，注意 partial/warnings。大型 Word 先返回正文，复制 images[].read_args 同步读取指定图片：缓存未命中时直接调用模型，解析成功后返回并缓存，不等待后台图片队列；next_read_args 用于结果分页或块读取续查。",
      parameters: {
        file_path: { type: "string", required: true },
        offset: { type: "number" },
        limit: { type: "number" },
        expected_revision: { type: "string" },
        image_offset: {
          type: "integer",
          description: "仅复制 next_images_args 继续列出图片位置。",
        },
        image_id: { type: "string", description: "仅复制图片 read_args。" },
        block_id: { type: "string", description: "仅复制搜索 read_args。" },
        image_mode: {
          type: "string",
          description:
            "transcription 读取文字，description 读取语义说明，仅用于 Word 图片位置。",
        },
        cursor: {
          type: "string",
          description:
            "只用于复制工具返回的续读参数；与 offset/limit/expected_revision 互斥。",
        },
      },
      output: {
        schema: readOutput,
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return (await reader.invoke("read", args, exec)) as ReadValue;
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "search_document",
      description:
        '在已提取文字中按字面包含、忽略大小写查找；关键词不拆词，不支持正则。PDF 同页/PPT 同幻灯片/Word 同块/Excel 同表判断。单词：keywords:["故障切换"]；或：keywords:["主备","集群"]；且：keywords:["主备","切换"],require_all:true。复制结果 read_args 读取上下文，复制 next_search_args 续查。生成说明不参与搜索。Word 默认 scope=all：先返回正文命中，再复制 next_search_args 分批补全图片；scope=text 仅正文。不完整或图片失败时不得声称全文不存在。result_id 相同且 update=true 的结果覆盖旧条目。',
      parameters: {
        file_path: { type: "string", required: true },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "首次查询必填。",
        },
        scope: {
          type: "string",
          description: "仅渐进 Word：all 默认完整搜索，text 仅正文。",
        },
        require_all: {
          type: "boolean",
          description: "默认 false；true 要求同一范围内全部命中。",
        },
        cursor: {
          type: "string",
          description:
            "仅复制 next_search_args；与 keywords/require_all 互斥。",
        },
      },
      output: {
        schema: searchOutput,
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return (await reader.invoke("search", args, exec)) as SearchValue;
      },
    }),
  );
}
