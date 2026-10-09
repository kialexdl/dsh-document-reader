/** Managed subprocess protocol; no source path is passed to the Python parser. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-subprocess";
import type {} from "@deepseek-ai/dsh-fs";
import type { FsTarget, FsInfo } from "@deepseek-ai/dsh-fs";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { MiB, visionSource } from "./config.js";
import type { DshVision } from "./vision.js";
import { ByteStore, Cache, validateEntry } from "./cache.js";
import type { Entry } from "./cache.js";
import type { Metadata } from "./types.js";
import { aborted, fail, DocumentError } from "./errors.js";

class Reader {
  private pending = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;
  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async take(max: number): Promise<Buffer> {
    if (!this.pending.length) {
      const next = await this.iterator.next();
      if (next.done) return Buffer.alloc(0);
      this.pending = Buffer.from(next.value);
    }
    const b = this.pending.subarray(0, max);
    this.pending = this.pending.subarray(b.length);
    return b;
  }
  async json(): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= 65536) {
      const b = await this.take(65536 - size + 1);
      if (!b.length) break;
      const end = b.indexOf(10);
      if (end >= 0) {
        this.pending = Buffer.concat([b.subarray(end + 1), this.pending]);
        chunks.push(b.subarray(0, end));
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      chunks.push(b);
      size += b.length;
    }
    fail("DOCUMENT_PROTOCOL_INVALID", "转换程序返回了无效协议帧。");
  }
  async transfer(
    store: ByteStore,
    bytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    let left = bytes;
    while (left) {
      aborted(signal);
      const chunk = await this.take(Math.min(left, 65536));
      if (!chunk.length)
        fail("DOCUMENT_PROTOCOL_INVALID", "转换结果意外结束。");
      await store.append(chunk);
      left -= chunk.length;
    }
    store.finish();
  }
}
async function write(stream: Writable, data: Buffer | string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    stream.write(data, (error) => (error ? reject(error) : resolve())),
  );
}
export function validateMeta(value: unknown, config: Config): Metadata {
  const v = value as Metadata & { code?: string; message?: string };
  if (!v || v.protocol !== 1)
    fail("DOCUMENT_PROTOCOL_INVALID", "转换协议版本错误。");
  if (!v.ok)
    fail(
      /^DOCUMENT_|^MARKITDOWN_/u.test(v.code ?? "")
        ? v.code!
        : "DOCUMENT_CONVERSION_FAILED",
      (v.message ?? "转换失败。").slice(0, 500),
    );
  for (const key of ["bodyBytes", "mapBytes", "records", "totalLines"] as const)
    if (!Number.isSafeInteger(v[key]) || v[key] < 0)
      fail("DOCUMENT_PROTOCOL_INVALID", "转换元数据无效。");
  if (
    v.bodyBytes + v.mapBytes > config.conversion.maxResultMiB * MiB ||
    v.records > config.conversion.maxMapRecords
  )
    fail("DOCUMENT_LIMIT_EXCEEDED", "转换结果超过硬上限。");
  if (
    !["page", "slide", "block", "sheet", "record", "image"].includes(v.scope) ||
    !Array.isArray(v.warnings) ||
    v.warnings.length > 24 ||
    !v.warnings.every((x) => typeof x === "string" && x.length <= 500) ||
    !Array.isArray(v.excluded_content) ||
    !v.excluded_content.every((x) => typeof x === "string") ||
    !["no_known_gaps", "known_gaps", "unknown"].includes(
      v.extraction_coverage,
    ) ||
    ["visionUsed", "ocrUsed", "partial"].some(
      (k) => typeof (v as unknown as Record<string, unknown>)[k] !== "boolean",
    )
  )
    fail("DOCUMENT_PROTOCOL_INVALID", "转换状态无效。");
  return v;
}
export class PythonBridge {
  private readonly executables = new Map<string, Promise<string>>();
  private readonly handles = new Set<SubprocessHandle>();
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly cache: Cache,
  ) {}
  private spawn(
    argv: string[],
    cwd: string,
    signal: AbortSignal,
    env: NodeJS.ProcessEnv = {},
    config: Config = this.config,
  ): SubprocessHandle {
    const h = this.ctx.subprocess.spawn({
      argv,
      cwd,
      signal,
      graceMs: config.python.terminateGraceMs,
      env,
      stdio: { stdin: "pipe", stdout: "pipe", stderr: { maxBytes: 4096 } },
    });
    h.done.catch(() => {});
    h.stdin?.on("error", () => {
      /* write callbacks report failure without exposing diagnostics */
    });
    this.handles.add(h);
    return h;
  }
  private async stop(h: SubprocessHandle): Promise<void> {
    h.terminate();
    try {
      await h.done;
    } catch {
      /* spawn failure is reported by the caller */
    }
    // Do not delete temp files while a managed child range remains alive.
    const gone = await h.waitForExit();
    if (!gone) fail("DOCUMENT_PROCESS_BUSY", "转换进程尚未退出。");
    this.handles.delete(h);
  }
  private async discover(config: Config): Promise<string> {
    const venv =
      process.platform === "win32"
        ? join(
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
            "dsh-document-reader",
            "venv",
            "Scripts",
            "python.exe",
          )
        : join(
            process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
            "dsh-document-reader",
            "venv",
            "bin",
            "python",
          );
    const candidates = config.python.executable
      ? [config.python.executable]
      : [
          venv,
          "python",
          "python3",
          ...(process.platform === "win32" ? ["py"] : []),
        ];
    let last: DocumentError | undefined;
    for (const candidate of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        config.python.startupTimeoutMs,
      );
      let h: SubprocessHandle | undefined;
      try {
        const executable = await this.ctx.subprocess.resolveExecutable(
          candidate,
          undefined,
          controller.signal,
        );
        h = this.spawn(
          [
            executable,
            ...(candidate === "py" ? ["-3"] : []),
            "-I",
            "-X",
            "utf8",
            "-u",
            fileURLToPath(
              new URL("../python/markitdown_bridge.py", import.meta.url),
            ),
            "--doctor",
          ],
          await this.cache.root(),
          controller.signal,
          {},
          config,
        );
        h.stdin!.end();
        const result = (await new Reader(h.stdout!).json()) as {
          ok?: boolean;
          protocol?: number;
          executable?: string;
          python?: number[];
          code?: string;
          message?: string;
        };
        if (result.ok === false)
          throw new DocumentError(
            result.code ?? "MARKITDOWN_MISSING",
            result.message ?? "Python 依赖不可用。",
          );
        const outcome = await h.done;
        if (
          outcome.exitCode === 0 &&
          result.protocol === 1 &&
          result.executable &&
          result.python &&
          (result.python[0]! > 3 ||
            (result.python[0] === 3 && result.python[1]! >= 10))
        )
          return result.executable;
      } catch (error) {
        if (error instanceof DocumentError) last = error;
      } finally {
        clearTimeout(timer);
        if (h) await this.stop(h);
      }
    }
    throw (
      last ??
      new DocumentError(
        "PYTHON_NOT_FOUND",
        "找不到可用的 Python 环境，请运行 scripts/setup-python.ps1 或 setup-python.sh。",
      )
    );
  }
  async convert(
    input: {
      key: string;
      session: string;
      file: string;
      format: string;
      target: FsTarget;
      info: FsInfo;
      signal: AbortSignal;
      config?: Config;
      vision?: DshVision;
      deferredDir?: string;
    },
    approve: (bytes: number) => Promise<void>,
  ): Promise<Entry> {
    const config = input.config ?? this.config;
    const { cache } = this;
    const size = input.info.size;
    if (size === undefined)
      fail(
        "DOCUMENT_PROVIDER_UNSUPPORTED",
        "当前文件服务未返回源大小；V1 需要本地普通文件元数据。",
      );
    if (size > config.conversion.maxSourceMiB * MiB)
      fail("DOCUMENT_LIMIT_EXCEEDED", "源文件超过 conversion.maxSourceMiB。");
    await cache.reserve(input.key, size, approve);
    let h: SubprocessHandle | undefined,
      body: ByteStore | undefined,
      mapping: ByteStore | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal.aborted) cancel();
    let timer: ReturnType<typeof setTimeout> | undefined,
      deadline = Date.now() + config.conversion.timeoutMs,
      timeout = false;
    const arm = () => {
      timer = setTimeout(
        () => {
          timeout = true;
          controller.abort();
        },
        Math.max(1, deadline - Date.now()),
      );
    };
    try {
      const executableKey = JSON.stringify(config.python);
      let discovery = this.executables.get(executableKey);
      if (!discovery) {
        discovery = this.discover(config).catch((error) => {
          this.executables.delete(executableKey);
          throw error;
        });
        this.executables.set(executableKey, discovery);
      }
      const executable = await discovery;
      await input.vision?.preflight(controller.signal);
      aborted(controller.signal);
      const root = await cache.root();
      const mode =
        config.vision.enabled && config.ocr.enabled
          ? "combined"
          : config.ocr.enabled
            ? "transcription"
            : "description";
      const prompt =
        config.vision.prompt ||
        (await readFile(
          new URL(`../prompts/image-${mode}.txt`, import.meta.url),
          "utf8",
        ));
      const request = {
        protocol: 1,
        sourceBytes: size,
        format: input.format,
        options: {
          memoryBytes: config.conversion.sourceMemoryMiB * MiB,
          maxSourceBytes: config.conversion.maxSourceMiB * MiB,
          maxResultBytes: config.conversion.maxResultMiB * MiB,
          maxArchiveBytes: config.conversion.maxArchiveMiB * MiB,
          maxArchiveEntries: config.conversion.maxArchiveEntries,
          maxMapRecords: config.conversion.maxMapRecords,
          pdfDpi: config.conversion.pdfDpi,
          deferredDir: input.deferredDir,
        },
        visual: {
          deferred: !!input.deferredDir,
          source: visionSource(config),
          maxImageBytes: config.vision.maxImageMiB * MiB,
          maxResponseBytes: config.vision.maxResponseChars * 4,
          vision: config.vision.enabled,
          ocr: config.ocr.enabled,
          baseURL: config.vision.baseURL,
          model: config.vision.model,
          requestTimeoutMs: config.vision.requestTimeoutMs,
          maxRetries: config.vision.maxRetries,
          maxCallsPerDocument: config.vision.maxCallsPerDocument,
          prompt,
        },
      };
      arm();
      h = this.spawn(
        [
          executable,
          "-I",
          "-X",
          "utf8",
          "-u",
          fileURLToPath(
            new URL("../python/markitdown_bridge.py", import.meta.url),
          ),
        ],
        root,
        controller.signal,
        {
          DOCUMENT_READER_TEMP: root,
          DOCUMENT_READER_VISION_KEY:
            visionSource(config) === "standalone" &&
            (config.vision.enabled || config.ocr.enabled)
              ? process.env[config.vision.apiKeyEnv]
              : undefined,
        },
        config,
      );
      const reader = new Reader(h.stdout!);
      await write(h.stdin!, JSON.stringify(request) + "\n");
      for (let position = 0; position < size; ) {
        aborted(controller.signal);
        const data = await this.ctx.fs.readByteRange(
          input.target,
          { offset: position, length: Math.min(65536, size - position) },
          controller.signal,
        );
        if (!data.length)
          fail("DOCUMENT_CHANGED", "读取期间源文件长度发生变化，请重试。");
        await write(h.stdin!, Buffer.from(data));
        position += data.length;
      }
      if (
        (await this.ctx.fs.stat(input.target, controller.signal))?.version !==
        input.info.version
      )
        fail("DOCUMENT_CHANGED", "读取期间源文件发生变化，请重试。");
      await write(h.stdin!, JSON.stringify({ action: "convert" }) + "\n");
      let message = await reader.json();
      let imageCount = 0;
      while (
        message &&
        typeof message === "object" &&
        "kind" in message &&
        message.kind === "vision"
      ) {
        const frame = message as {
          kind: string;
          id: number;
          bytes: number;
          mediaType: string;
        };
        if (
          !input.vision ||
          !Number.isSafeInteger(frame.id) ||
          frame.id !== ++imageCount ||
          imageCount > config.vision.maxCallsPerDocument ||
          !Number.isSafeInteger(frame.bytes) ||
          frame.bytes < 1 ||
          frame.bytes > config.vision.maxImageMiB * MiB
        )
          fail(
            "DOCUMENT_PROTOCOL_INVALID",
            "图片识别协议帧无效或超过调用上限。",
          );
        const image = Buffer.alloc(frame.bytes);
        for (let offset = 0; offset < image.length; ) {
          aborted(controller.signal);
          const bytes = await reader.take(
            Math.min(image.length - offset, 65536),
          );
          if (!bytes.length)
            fail("DOCUMENT_PROTOCOL_INVALID", "图片数据意外结束。");
          image.set(bytes, offset);
          offset += bytes.length;
        }
        const answer = await input.vision.analyze(
          image,
          frame.mediaType,
          prompt,
          controller.signal,
        );
        const text = Buffer.from(answer.text ?? "", "utf8");
        await write(
          h.stdin!,
          JSON.stringify({
            action: "vision-result",
            id: frame.id,
            ok: answer.ok,
            code: answer.code,
            textBytes: text.length,
          }) + "\n",
        );
        if (text.length) await write(h.stdin!, text);
        message = await reader.json();
      }
      const meta = validateMeta(message, config);
      const pause = Date.now();
      clearTimeout(timer);
      await cache.reserve(
        input.key,
        size +
          meta.bodyBytes +
          meta.mapBytes +
          Math.ceil(meta.bodyBytes / 1024) * 64,
        approve,
      );
      deadline += Date.now() - pause;
      arm();
      aborted(controller.signal);
      const memory = Math.min(
        config.cache.memoryEntryMiB * MiB,
        Math.floor(
          cache.memoryAvailable() / 2 / config.conversion.maxConcurrent,
        ),
      );
      body = new ByteStore(root, memory);
      mapping = new ByteStore(root, memory);
      await write(h.stdin!, JSON.stringify({ action: "release" }) + "\n");
      h.stdin!.end();
      await reader.transfer(body, meta.bodyBytes, controller.signal);
      await reader.transfer(mapping, meta.mapBytes, controller.signal);
      if ((await reader.take(1)).length || (await h.done).exitCode !== 0)
        fail("DOCUMENT_PROTOCOL_INVALID", "转换进程未正常完成。");
      if (
        (await this.ctx.fs.stat(input.target, controller.signal))?.version !==
        input.info.version
      )
        fail("DOCUMENT_CHANGED", "转换期间源文件发生变化，请重试。");
      const now = Date.now();
      const entry: Entry = {
        key: input.key,
        session: input.session,
        file: input.file,
        format: input.format,
        revision: randomUUID(),
        body,
        mapping,
        meta,
        index: [],
        created: now,
        accessed: now,
        pins: 0,
        expired: false,
        size: body.size + mapping.size,
        memory: 0,
      };
      await validateEntry(
        entry,
        controller.signal,
        Math.max(
          64,
          cache.memoryAvailable() - body.memoryBytes - mapping.memoryBytes,
        ),
      );
      await cache.publish(entry);
      body = undefined;
      mapping = undefined;
      return entry;
    } catch (error) {
      if (timeout) fail("DOCUMENT_TIMEOUT", "文档转换超时。");
      aborted(input.signal);
      if (error instanceof DocumentError) throw error;
      // Preserve provider errors, but never return subprocess stderr or an upstream endpoint response.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        String(error.code).startsWith("FS_")
      )
        throw error;
      throw new DocumentError(
        "DOCUMENT_CONVERSION_FAILED",
        "转换失败，请检查 Python 依赖、文件格式及视觉模型配置。",
      );
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", cancel);
      if (h) await this.stop(h);
      await body?.dispose();
      await mapping?.dispose();
      cache.releaseReservation(input.key);
    }
  }
  async prepareImage(
    source: string,
    directory: string,
    config: Config,
    signal: AbortSignal,
  ): Promise<{ tiles: string[]; warning?: string }> {
    const executableKey = JSON.stringify(config.python);
    let discovery = this.executables.get(executableKey);
    if (!discovery) {
      discovery = this.discover(config).catch((error) => {
        this.executables.delete(executableKey);
        throw error;
      });
      this.executables.set(executableKey, discovery);
    }
    const executable = await discovery;
    const h = this.spawn(
      [
        executable,
        "-I",
        "-X",
        "utf8",
        "-u",
        fileURLToPath(new URL("../python/prepare_image.py", import.meta.url)),
      ],
      directory,
      signal,
      {},
      config,
    );
    try {
      await write(
        h.stdin!,
        JSON.stringify({
          ...config.progressive,
          source,
          directory,
          maxBytes: config.vision.maxImageMiB * MiB,
          maxOutputBytes: Math.floor(
            (config.conversion.maxResultMiB * MiB) /
              config.progressive.imageConcurrency,
          ),
        }) + "\n",
      );
      h.stdin!.end();
      const result = (await new Reader(h.stdout!).json()) as {
        tiles: string[];
        warning?: string;
      };
      if (
        (await h.done).exitCode !== 0 ||
        !Array.isArray(result.tiles) ||
        result.tiles.length > config.progressive.maxTiles ||
        result.tiles.some((n) => !/^[a-f0-9]{64}\.png$/.test(n))
      )
        fail("DOCUMENT_IMAGE_INVALID", "图片切片失败或超出限制。");
      return result;
    } finally {
      await this.stop(h);
    }
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.handles].map((h) => this.stop(h)));
  }
}
