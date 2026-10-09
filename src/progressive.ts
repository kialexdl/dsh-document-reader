/** DOCX native-first reading, bounded image batches and restartable checkpoints. */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FsTarget, FsInfo } from "@deepseek-ai/dsh-fs";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { setMaxListeners } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import type { Config } from "./config.js";
import { MiB, visionSource } from "./config.js";
import { Cache, ByteStore, validateEntry, type Entry } from "./cache.js";
import { PythonBridge, validateMeta } from "./python.js";
import { DurableStore, digest } from "./durable.js";
import { ImageQueue, type ImageJob } from "./image-queue.js";
import { DshVision } from "./vision.js";
import { standaloneVision } from "./standalone-vision.js";
import { readWindow, type ReadState } from "./read.js";
import { search, searchInput, type SearchState } from "./search.js";
import { aborted, fail, jsonBytes, DocumentError } from "./errors.js";
import type {
  Location,
  Segment,
  ReadArgs,
  ReadValue,
  SearchArgs,
  SearchValue,
} from "./types.js";

type Mode = "transcription" | "description";
interface ImageRef {
  id: string;
  hash: string;
  scope: string;
  location: Location;
  line: number;
}
interface ImageResult {
  state: "done" | "failed";
  text: string;
  warning?: string;
  code?: string;
  file?: string;
}
interface DirectImage {
  controller: AbortController;
  done: Promise<void>;
  waiters: number;
}
interface Run {
  id: string;
  mode: Mode;
  config: Config;
  results: Map<string, ImageResult>;
  active?: Promise<void>;
  controller?: AbortController;
  warning?: string;
  epoch: number;
  calls: number;
  jobs: Map<string, ImageJob & { controller: AbortController }>;
  direct: Map<string, DirectImage>;
  batch?: {
    signal: AbortSignal;
    vision?: DshVision;
    finish(): void;
    started: number;
    count: number;
  };
}
interface Document {
  key: string;
  namespace: string;
  nativeKey: string;
  entry: Entry;
  directory: string;
  images: ImageRef[];
  scopes: Map<string, Segment[]>;
  runs: Map<string, Run>;
  snapshots: Map<string, Promise<Entry>>;
  generatedBytes: number;
}
interface Query {
  phase: "native" | "images";
  native: SearchState;
  scope: "all" | "text";
  index: number;
  imageState?: SearchState;
  imageEntry?: string;
}
type State =
  | { kind: "search"; query: Query }
  | {
      kind: "read";
      entryKey: string;
      state: ReadState;
      imageScope?: string;
      imageId?: string;
      refreshImage?: boolean;
      mode?: Mode;
    };
interface Token {
  session: string;
  key: string;
  revision: string;
  modeKey: string;
  state: State;
  time: number;
}
const transcriptionPrompt = readFileSync(
  new URL("../prompts/image-transcription.txt", import.meta.url),
  "utf8",
);
const descriptionPrompt = readFileSync(
  new URL("../prompts/image-description.txt", import.meta.url),
  "utf8",
);
export class ProgressiveReader {
  private documents = new Map<string, Promise<Document>>();
  private tokens = new Map<string, Token>();
  private durable: DurableStore;
  private lifetime = new AbortController();
  private epoch = 0;
  private imageQueue = new ImageQueue();
  private building = 0;
  private nativeFlights = new Map<
    string,
    { controller: AbortController; waiters: number; session: string }
  >();
  constructor(
    private ctx: Context,
    private cache: Cache,
    private python: PythonBridge,
    private legacyConversions: () => number = () => 0,
  ) {
    this.durable = new DurableStore(cache);
  }
  get activeConversions(): number {
    return this.building;
  }
  invalidate(): void {
    this.epoch++;
    for (const p of this.documents.values())
      void p
        .then((d) => {
          for (const r of d.runs.values()) {
            r.controller?.abort();
            for (const flight of r.direct.values()) flight.controller.abort();
          }
        })
        .catch(() => {});
  }
  private modeKey(config: Config, mode: Mode): string {
    return digest({
      version: 3,
      source: visionSource(config),
      provider: config.vision.provider,
      model: config.vision.model,
      endpoint: config.vision.baseURL,
      mode,
      prompt:
        mode === "transcription"
          ? config.progressive.ocrPrompt || transcriptionPrompt
          : config.vision.prompt || descriptionPrompt,
      tile: [
        config.progressive.tilePixels,
        config.progressive.tileOverlap,
        config.progressive.maxTiles,
        config.progressive.maxImagePixels,
      ],
      maxResponse: config.vision.maxResponseChars,
      cacheVersion: config.progressive.cacheVersion,
    });
  }
  private token(
    doc: Document,
    modeKey: string,
    state: State,
    config: Config,
  ): string {
    const budget = Math.min(
      (config.cache.memoryTotalMiB * MiB) / 4,
      (config.cache.maxTotalMiB * MiB) / 4,
    );
    const value = {
      session: doc.entry.session,
      key: doc.key,
      revision: doc.entry.revision,
      modeKey,
      state: structuredClone(state),
      time: Date.now(),
    };
    if (jsonBytes(value) > budget)
      fail("DOCUMENT_LIMIT_EXCEEDED", "续查状态超出预算。");
    while (
      this.tokens.size >= config.cache.maxCursors ||
      [...this.tokens.values()].reduce(
        (n, v) => n + jsonBytes(v),
        jsonBytes(value),
      ) > budget
    )
      this.tokens.delete(this.tokens.keys().next().value!);
    const id = "progressive:" + randomUUID();
    this.tokens.set(id, value);
    return id;
  }
  private async authorize(
    target: FsTarget,
    version: FsInfo["version"],
    signal: AbortSignal,
  ): Promise<void> {
    aborted(signal);
    await this.ctx.fs.readByteRange(target, { offset: 0, length: 1 }, signal);
    if ((await this.ctx.fs.stat(target, signal))?.version !== version)
      fail("DOCUMENT_CHANGED", "源文件发生变化，请重新搜索。");
  }
  private async buildDocument(
    key: string,
    nativeKey: string,
    namespace: string,
    session: string,
    target: FsTarget,
    info: FsInfo,
    config: Config,
    signal: AbortSignal,
    exec: ToolExecution,
  ): Promise<Document> {
    const started = Date.now();
    const directory = await mkdtemp(join(await this.cache.root(), "docx-"));
    let entry: Entry | undefined;
    const approve = async (bytes: number) => {
      const approval = this.ctx.get("approval");
      if (!approval || !exec.agent)
        fail(
          "DOCUMENT_LIMIT_EXCEEDED",
          "缓存超过配额，需要审批服务或提高缓存上限。",
        );
      const result = await approval.request({
        agent: exec.agent,
        callId: exec.callId,
        toolName: "search_document",
        reason: `本次 Word 正文及内嵌图片需要 ${Math.ceil(bytes / MiB)} MiB 临时缓存，是否仅允许本次？`,
        signal,
      });
      if (result !== "allowed-once")
        fail("DOCUMENT_LIMIT_EXCEEDED", "本次超额缓存未获批准。");
    };
    try {
      if (await this.durable.loadDocument(nativeKey, directory, config)) {
        const body = new ByteStore(directory, 0),
          mapping = new ByteStore(directory, 0);
        try {
          const meta = validateMeta(
            JSON.parse(await readFile(join(directory, "meta.json"), "utf8")),
            config,
          );
          if (
            (await stat(join(directory, "body.bin"))).size !== meta.bodyBytes ||
            (await stat(join(directory, "mapping.bin"))).size !== meta.mapBytes
          )
            throw Error("snapshot size");
          await this.cache.reserve(
            key,
            meta.bodyBytes + meta.mapBytes,
            approve,
          );
          for (const [name, store] of [
            ["body.bin", body],
            ["mapping.bin", mapping],
          ] as const) {
            for await (const chunk of createReadStream(join(directory, name))) {
              aborted(signal);
              await store.append(Buffer.from(chunk));
            }
            store.finish();
          }
          entry = {
            key,
            session,
            file: target.displayPath,
            format: "docx",
            revision: nativeKey,
            body,
            mapping,
            meta,
            index: [],
            created: Date.now(),
            accessed: Date.now(),
            pins: 0,
            expired: false,
            size: body.size + mapping.size,
            memory: 0,
          };
          await validateEntry(entry, signal);
          await this.cache.publish(entry);
        } catch (error) {
          await body.dispose();
          await mapping.dispose();
          this.cache.releaseReservation(key);
          aborted(signal);
          if (
            error instanceof DocumentError &&
            [
              "DOCUMENT_LIMIT_EXCEEDED",
              "DOCUMENT_BUSY",
              "DOCUMENT_CANCELLED",
            ].includes(error.code)
          )
            throw error;
          entry = undefined;
        }
      }
      if (!entry) {
        const native = structuredClone(config);
        native.vision.enabled = false;
        native.ocr.enabled = false;
        entry = await this.python.convert(
          {
            key,
            session,
            file: target.displayPath,
            format: "docx",
            target,
            info,
            signal,
            config: native,
            deferredDir: directory,
          },
          approve,
        );
        entry.revision = nativeKey;
        try {
          await this.durable.saveDocument(nativeKey, entry, directory, config);
        } catch {
          entry.meta.warnings.push(
            "持久缓存不可写或配额不足，本次仍可继续，重启后可能需要重新解析。",
          );
        }
      }
      const manifestPath = join(directory, "images.json");
      if (
        (await stat(manifestPath)).size >
        config.conversion.maxResultMiB * MiB
      )
        fail("DOCUMENT_LIMIT_EXCEEDED", "图片位置清单过大。");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        images: ImageRef[];
        assets: Record<string, number>;
      };
      if (
        !Array.isArray(manifest.images) ||
        manifest.images.length > config.conversion.maxMapRecords ||
        !manifest.assets
      )
        fail("DOCUMENT_PROTOCOL_INVALID", "图片位置清单无效。");
      const ids = new Set<string>();
      for (const im of manifest.images) {
        if (
          !/^image:\d+$/.test(im.id) ||
          ids.has(im.id) ||
          !/^[a-f0-9]{64}$/.test(im.hash) ||
          !im.scope.startsWith("block:") ||
          !im.location ||
          !Number.isInteger(im.line)
        )
          fail("DOCUMENT_PROTOCOL_INVALID", "图片位置无效。");
        ids.add(im.id);
      }
      let assetBytes = 0;
      for (const hash of new Set(manifest.images.map((i) => i.hash))) {
        const asset = await stat(join(directory, hash + ".image"));
        if (!asset.isFile() || asset.size !== manifest.assets[hash])
          fail("DOCUMENT_CACHE_INVALID", "图片缓存不完整，请重新解析。");
        assetBytes += asset.size;
      }
      entry.size += assetBytes + (await stat(manifestPath)).size;
      await this.cache.reserve(key, entry.size, approve);
      this.cache.releaseReservation(key);
      const scopes = new Map<string, Segment[]>();
      for (const im of manifest.images) scopes.set(im.scope, []);
      for (let p = 0; p < entry.mapping.size; ) {
        const row = (await entry.mapping.record(p))!;
        p = row.next;
        scopes.get(row.value.scope)?.push(row.value);
      }
      await this.authorize(target, info.version, signal);
      this.ctx.logger.info(
        `Word 正文就绪：耗时 ${Date.now() - started} 毫秒，图片位置 ${manifest.images.length}，不同图片 ${Object.keys(manifest.assets).length}。`,
      );
      return {
        key,
        namespace,
        nativeKey,
        entry,
        directory,
        images: manifest.images,
        scopes,
        runs: new Map(),
        snapshots: new Map(),
        generatedBytes: 0,
      };
    } catch (error) {
      await this.cache.invalidate(key);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private run(doc: Document, config: Config, mode: Mode): Run {
    const id = this.modeKey(config, mode) + ":" + this.epoch;
    let r = doc.runs.get(id);
    if (!r) {
      r = {
        id,
        mode,
        config: structuredClone(config),
        results: new Map(),
        epoch: this.epoch,
        calls: 0,
        jobs: new Map(),
        direct: new Map(),
      };
      doc.runs.set(id, r);
    }
    if (!r.active && !r.direct.size) r.config = structuredClone(config);
    return r;
  }
  private async image(
    doc: Document,
    hash: string,
    run: Run,
    vision: DshVision | undefined,
    signal: AbortSignal,
  ): Promise<ImageResult> {
    const c = run.config,
      modeKey = this.modeKey(c, run.mode),
      key = digest([doc.namespace, hash, modeKey]);
    const cached = await this.durable.getResult(key, c);
    if (cached !== undefined) {
      try {
        const result = JSON.parse(cached);
        if (result.state === "done" && typeof result.text === "string")
          return result;
      } catch {}
    }
    const tileDirectory = await mkdtemp(join(doc.directory, "tiles-"));
    try {
      const prepared = await this.python.prepareImage(
        join(doc.directory, hash + ".image"),
        tileDirectory,
        c,
        signal,
      );
      const pieces: string[] = [];
      for (const tile of prepared.tiles) {
        aborted(signal);
        const tileKey = digest([doc.namespace, tile, modeKey, "tile"]);
        let text = await this.durable.getResult(tileKey, c);
        if (text === undefined) {
          const data = await readFile(join(tileDirectory, tile));
          const prompt =
            run.mode === "transcription"
              ? c.progressive.ocrPrompt || transcriptionPrompt
              : c.vision.prompt || descriptionPrompt;
          const answer = vision
            ? await vision.analyze(data, "image/png", prompt, signal)
            : await standaloneVision(
                data,
                prompt,
                c,
                signal,
                () => run.calls++ < c.vision.maxCallsPerDocument,
              );
          if (!answer.ok)
            return { state: "failed", text: "", code: answer.code };
          try {
            const obj = JSON.parse(answer.text!);
            if (
              !obj ||
              typeof obj.transcript !== "string" ||
              typeof obj.description !== "string" ||
              Object.keys(obj).sort().join(",") !== "description,transcript"
            )
              throw Error();
            text =
              run.mode === "transcription" ? obj.transcript : obj.description;
          } catch {
            return {
              state: "failed",
              text: "",
              code: "VISION_STRUCTURE_INVALID",
            };
          }
          aborted(signal);
          // An explicitly empty transcript is a successful no-text observation.
          try {
            await this.durable.putResult(tileKey, text!, c);
          } catch {
            run.warning = "部分识别检查点未能写入持久缓存。";
          }
        }
        pieces.push(text!);
        if (
          pieces.reduce((n, t) => n + t.length, 0) > c.vision.maxResponseChars
        )
          return { state: "failed", text: "", code: "VISION_RESPONSE_LIMIT" };
      }
      if (!pieces.length)
        return { state: "failed", text: "", code: "IMAGE_NO_TILES" };
      aborted(signal);
      const result: ImageResult = {
        state: "done",
        text: pieces.join("\n"),
        warning: prepared.warning,
      };
      try {
        await this.durable.putResult(key, JSON.stringify(result), c);
      } catch {
        run.warning = "部分识别检查点未能写入持久缓存。";
      }
      return result;
    } finally {
      await rm(tileDirectory, { recursive: true, force: true });
    }
  }

  /** Publish once, using a unique file so a cancelled worker cannot overwrite it. */
  private async publishImage(
    doc: Document,
    run: Run,
    hash: string,
    result: ImageResult,
    signal: AbortSignal,
  ): Promise<void> {
    aborted(signal);
    if (run.results.get(hash)?.state === "done") return;
    if (result.state !== "done") {
      run.results.set(hash, result);
      return;
    }
    const bytes = Buffer.byteLength(result.text);
    if (doc.generatedBytes + bytes > run.config.conversion.maxResultMiB * MiB)
      fail("DOCUMENT_LIMIT_EXCEEDED", "图片转录总量超过结果上限。");
    const file = digest([hash, run.id]) + "-" + randomUUID() + ".transcript";
    doc.generatedBytes += bytes;
    let published = false;
    try {
      await writeFile(join(doc.directory, file), result.text, { mode: 0o600 });
      aborted(signal);
      if (run.results.get(hash)?.state === "done") return;
      run.results.set(hash, { ...result, text: "", file });
      published = true;
    } finally {
      if (!published) {
        doc.generatedBytes -= bytes;
        await rm(join(doc.directory, file), { force: true });
      }
    }
  }

  /** Explicit image reads bypass the background queue and wait for their model result. */
  private async directImage(
    doc: Document,
    run: Run,
    hash: string,
    target: FsTarget,
    info: FsInfo,
    exec: ToolExecution,
    config: Config,
  ): Promise<void> {
    aborted(exec.signal);
    if (run.results.get(hash)?.state === "done") return;
    let flight = run.direct.get(hash);
    // A cancelled flight is being cleaned up; wait only for its cleanup, then retry.
    if (flight?.controller.signal.aborted) {
      await flight.done.catch(() => {});
      aborted(exec.signal);
      return this.directImage(doc, run, hash, target, info, exec, config);
    }
    if (!flight) {
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(config.conversion.timeoutMs);
      const signal = AbortSignal.any([
        controller.signal,
        timeout,
        this.lifetime.signal,
      ]);
      // A foreground request owns its budget and timeout, independently of the batch.
      const localRun: Run = {
        ...run,
        config: structuredClone(config),
        calls: 0,
        warning: undefined,
      };
      const vision =
        visionSource(config) === "dsh"
          ? new DshVision(
              this.ctx,
              localRun.config.vision,
              exec.agent?.session,
              () => run.epoch === this.epoch,
            )
          : undefined;
      const current: DirectImage = {
        controller,
        done: Promise.resolve(),
        waiters: 0,
      };
      run.direct.set(hash, current);
      doc.entry.pins++;
      // Cancel only this image's queued/running background work. Other images continue.
      run.jobs.get(hash)?.controller.abort();
      current.done = (async () => {
        try {
          await this.authorize(target, info.version, signal);
          const result = await this.image(doc, hash, localRun, vision, signal);
          aborted(signal);
          await this.authorize(target, info.version, signal);
          if (result.state !== "done")
            fail(
              result.code ?? "IMAGE_PROCESSING_FAILED",
              "指定图片解析失败，请重试或检查图片模型配置。",
            );
          await this.publishImage(doc, run, hash, result, signal);
          if (localRun.warning) run.warning = localRun.warning;
        } catch (error) {
          if (timeout.aborted)
            fail("DOCUMENT_TIMEOUT", "指定图片解析超时，请重试。");
          aborted(signal);
          if (error instanceof DocumentError) throw error;
          fail(
            "IMAGE_PROCESSING_FAILED",
            "指定图片解析失败，请重试或检查图片模型配置。",
          );
        } finally {
          if (run.direct.get(hash) === current) run.direct.delete(hash);
          await this.cache.unpin(doc.entry);
        }
      })();
      void current.done.catch(() => {});
      flight = current;
    }
    flight.waiters++;
    let cancel = () => {};
    try {
      await Promise.race([
        flight.done,
        new Promise<never>((_, reject) => {
          cancel = () =>
            reject(
              new DocumentError("DOCUMENT_CANCELLED", "当前图片读取已取消。"),
            );
          exec.signal.addEventListener("abort", cancel, { once: true });
          if (exec.signal.aborted) cancel();
        }),
      ]);
      aborted(exec.signal);
    } finally {
      exec.signal.removeEventListener("abort", cancel);
      if (--flight.waiters === 0 && run.direct.get(hash) === flight)
        flight.controller.abort();
    }
  }

  private start(
    doc: Document,
    run: Run,
    target: FsTarget,
    info: FsInfo,
    exec: ToolExecution,
    hashes?: string[],
  ): void {
    const priority = hashes !== undefined;
    // Background continuation stays bounded; explicit reads can join an active batch.
    if (run.active && !priority) return;
    const requested = [...new Set(hashes ?? doc.images.map((i) => i.hash))];
    if (priority) for (const hash of requested) run.jobs.get(hash)?.promote();
    const selected = requested
      .filter(
        (h) => !run.results.has(h) && !run.jobs.has(h) && !run.direct.has(h),
      )
      .slice(0, run.config.progressive.batchImages);
    if (!selected.length) return;
    if (!run.batch) {
      const controller = new AbortController();
      run.calls = 0;
      run.controller = controller;
      const signal = AbortSignal.any([
        controller.signal,
        this.lifetime.signal,
        AbortSignal.timeout(run.config.conversion.timeoutMs),
      ]);
      // Each queued image owns a removable abort listener on this batch signal.
      setMaxListeners(0, signal);
      let finish!: () => void;
      run.active = new Promise<void>((resolve) => {
        finish = resolve;
      });
      run.batch = {
        signal,
        finish,
        started: Date.now(),
        count: 0,
        vision:
          visionSource(run.config) === "dsh"
            ? new DshVision(
                this.ctx,
                run.config.vision,
                exec.agent?.session,
                () => run.epoch === this.epoch,
              )
            : undefined,
      };
      doc.entry.pins++;
    }
    const batch = run.batch;
    batch.count += selected.length;
    for (const hash of selected) {
      const controller = new AbortController();
      const signal = AbortSignal.any([batch.signal, controller.signal]);
      const job = this.imageQueue.enqueue(
        async () => {
          aborted(signal);
          if (run.results.get(hash)?.state === "done") return;
          await this.authorize(target, info.version, signal);
          const result = await this.image(doc, hash, run, batch.vision, signal);
          await this.authorize(target, info.version, signal);
          aborted(signal);
          await this.publishImage(doc, run, hash, result, signal);
        },
        run.config.progressive.imageConcurrency,
        signal,
        priority,
      );
      // Keep the exposed completion tied to publication and bookkeeping, not the batch.
      const done = job.done
        .catch((error) => {
          if (controller.signal.aborted) return;
          if (batch.signal.aborted) {
            run.warning = "图片任务中断，续查可从已保存的检查点继续。";
            return;
          }
          if (run.results.get(hash)?.state === "done") return;
          run.results.set(hash, {
            state: "failed",
            text: "",
            code:
              error instanceof DocumentError
                ? error.code
                : "IMAGE_PROCESSING_FAILED",
          });
        })
        .finally(async () => {
          run.jobs.delete(hash);
          if (!run.jobs.size) {
            this.ctx.logger.info(
              `Word 图片批次结束：${batch.count} 张不同图片，耗时 ${Date.now() - batch.started} 毫秒。`,
            );
            run.active = undefined;
            run.controller = undefined;
            run.batch = undefined;
            try {
              await this.cache.unpin(doc.entry);
            } finally {
              batch.finish();
            }
          }
        });
      // Observe bookkeeping errors even after the tool response has returned.
      void done.catch(() => {});
      run.jobs.set(hash, { done, promote: job.promote, controller });
    }
  }
  private progress(
    doc: Document,
    run: Run | undefined,
    scope: "all" | "text",
    config: Config,
  ) {
    const completed = doc.images.filter(
      (i) => run?.results.get(i.hash)?.state === "done",
    ).length;
    const failed = doc.images.filter(
      (i) => run?.results.get(i.hash)?.state === "failed",
    ).length;
    const disabled =
      scope === "text" ||
      !(run?.mode === "description"
        ? config.vision.enabled
        : config.ocr.enabled);
    return {
      total: doc.images.length,
      completed,
      failed,
      pending: disabled ? 0 : doc.images.length - completed - failed,
      skipped: disabled ? doc.images.length : 0,
      running: !!run?.active || !!run?.direct.size,
    };
  }
  private async wait(
    run: Run | undefined,
    ms: number,
    signal: AbortSignal,
    hashes?: string[],
  ): Promise<void> {
    if (!run?.active) return;
    const completion = hashes
      ? Promise.all(hashes.map((hash) => run.jobs.get(hash)?.done))
      : run.active;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      completion.then(done, done);
      if (signal.aborted) done();
    });
    aborted(signal);
  }
  private async snapshot(
    doc: Document,
    scope: string,
    run: Run | undefined,
    config: Config,
  ): Promise<Entry> {
    const parts: Array<{
      text: string;
      source: Segment["source"];
      location: Location;
    }> = [];
    for (const seg of doc.scopes.get(scope) ?? [])
      parts.push({
        text: (
          await doc.entry.body.slice(seg.start, seg.end - seg.start)
        ).toString("utf8"),
        source: seg.source,
        location: seg.location,
      });
    for (const image of doc.images.filter((i) => i.scope === scope)) {
      const result = run?.results.get(image.hash);
      if (result?.state === "done")
        parts.push({
          text:
            "\n" +
            (result.file
              ? await readFile(join(doc.directory, result.file), "utf8")
              : result.text) +
            "\n",
          source:
            run!.mode === "transcription"
              ? "ocr_transcript"
              : "generated_description",
          location: { ...image.location, part: image.id },
        });
    }
    const key = digest([doc.key, scope, run?.id, parts]);
    const old = this.cache.entries.get(key);
    if (old && !old.expired) return old;
    const existing = doc.snapshots.get(key);
    if (existing) return existing;
    const build = async () => {
      const body = new ByteStore(await this.cache.root(), 0),
        mapping = new ByteStore(await this.cache.root(), 0);
      let line = 1,
        records = 0;
      try {
        for (const part of parts) {
          if (!part.text) continue;
          const b = Buffer.from(part.text),
            start = body.size;
          const record: Segment = {
            start,
            end: start + b.length,
            startLine: line,
            endLine: line + (part.text.match(/\n/g)?.length ?? 0),
            scope,
            location: part.location,
            source: part.source,
          };
          await body.append(b);
          await mapping.append(Buffer.from(JSON.stringify(record) + "\n"));
          line = record.endLine;
          records++;
          if (body.size + mapping.size > config.conversion.maxResultMiB * MiB)
            fail("DOCUMENT_LIMIT_EXCEEDED", "块内容超过上限。");
        }
        body.finish();
        mapping.finish();
        const meta = {
          ...doc.entry.meta,
          bodyBytes: body.size,
          mapBytes: mapping.size,
          totalLines: body.size ? line : 0,
          records,
          ocrUsed: parts.some(
            (p) => p.source === "ocr_transcript" && p.text.trim().length > 0,
          ),
          visionUsed: parts.some(
            (p) =>
              p.source === "generated_description" && p.text.trim().length > 0,
          ),
        };
        const entry: Entry = {
          ...doc.entry,
          key,
          revision: key,
          body,
          mapping,
          meta,
          index: [],
          pins: 0,
          size: body.size + mapping.size,
          memory: 0,
          created: Date.now(),
          accessed: Date.now(),
          expired: false,
        };
        await this.cache.reserve(key, entry.size, async () =>
          fail("DOCUMENT_LIMIT_EXCEEDED", "块缓存超过配额。"),
        );
        await validateEntry(entry);
        await this.cache.publish(entry);
        return entry;
      } catch (error) {
        await body.dispose();
        await mapping.dispose();
        this.cache.releaseReservation(key);
        throw error;
      }
    };
    const promise = build().finally(() => doc.snapshots.delete(key));
    doc.snapshots.set(key, promise);
    return promise;
  }

  async invoke(
    kind: "read" | "search",
    args: ReadArgs | SearchArgs,
    exec: ToolExecution,
    target: FsTarget,
    info: FsInfo,
    config: Config,
  ): Promise<ReadValue | SearchValue> {
    const session = exec.agent?.session.id ?? "detached";
    const nativeKey = digest([
      "docx-native-v3",
      target.targetKey,
      info.version,
      config.conversion,
      config.python,
    ]);
    const key = digest([session, nativeKey]);
    const modeKey = this.modeKey(config, "transcription") + ":" + this.epoch;
    const token = args.cursor ? this.tokens.get(args.cursor) : undefined;
    if (
      args.cursor &&
      (!token ||
        token.session !== session ||
        token.key !== key ||
        token.state.kind !== kind ||
        Date.now() - token.time > config.cache.ttlMinutes * 60000 ||
        token.modeKey !== modeKey)
    )
      fail("DOCUMENT_CURSOR_INVALID", "续查已过期或模型配置变化，请重新搜索。");
    let promise = this.documents.get(key);
    if (promise && !this.nativeFlights.has(key)) {
      const doc = await promise;
      const existing = await this.cache.acquire(key);
      if (existing) await this.cache.unpin(existing);
      else {
        await this.remove(key, doc);
        promise = undefined;
        if (token)
          fail("DOCUMENT_CURSOR_INVALID", "正文缓存已失效，请重新搜索。");
      }
    }
    if (!promise) {
      if (this.documents.size >= config.cache.maxCursors)
        fail("DOCUMENT_BUSY", "文档数量达到缓存上限，请结束旧会话后重试。");
      if (
        this.building + this.legacyConversions() >=
        config.conversion.maxConcurrent
      )
        fail("DOCUMENT_BUSY", "正文解析任务已满，请稍后重试。");
      this.building++;
      const controller = new AbortController();
      this.nativeFlights.set(key, { controller, waiters: 0, session });
      promise = this.buildDocument(
        key,
        nativeKey,
        digest(target.targetKey),
        session,
        target,
        info,
        config,
        AbortSignal.any([controller.signal, this.lifetime.signal]),
        exec,
      ).finally(() => {
        this.building--;
        this.nativeFlights.delete(key);
      });
      this.documents.set(key, promise);
      promise.catch(() => this.documents.delete(key));
    }
    const flight = this.nativeFlights.get(key);
    if (flight) flight.waiters++;
    let doc: Document;
    let cancelWait = () => {};
    try {
      doc = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          cancelWait = () =>
            reject(new DocumentError("DOCUMENT_CANCELLED", "当前调用已取消。"));
          exec.signal.addEventListener("abort", cancelWait, { once: true });
          if (exec.signal.aborted) cancelWait();
        }),
      ]);
    } finally {
      exec.signal.removeEventListener("abort", cancelWait);
      if (flight && --flight.waiters === 0 && this.nativeFlights.has(key))
        flight.controller.abort();
    }
    if (
      "expected_revision" in args &&
      args.expected_revision !== undefined &&
      args.expected_revision !== doc.entry.revision
    )
      fail("DOCUMENT_REVISION_EXPIRED", "文档版本变化，请重新定位。");
    const entry = await this.cache.acquire(key);
    if (!entry)
      fail("DOCUMENT_REVISION_EXPIRED", "正文缓存已失效，请重新搜索。");
    const isImageRead =
      kind === "read" &&
      (!!(args as ReadArgs).image_id ||
        (token?.state.kind === "read" && !!token.state.imageId));
    const cancel = () => {
      if (!isImageRead)
        for (const run of doc.runs.values()) run.controller?.abort();
    };
    exec.signal.addEventListener("abort", cancel, { once: true });
    try {
      let value: ReadValue | SearchValue;
      if (kind === "search")
        value = await this.query(
          doc,
          args as SearchArgs,
          token?.state.kind === "search" ? token.state.query : undefined,
          modeKey,
          exec,
          target,
          info,
          config,
        );
      else
        value = await this.read(
          doc,
          args as ReadArgs,
          token?.state.kind === "read" ? token.state : undefined,
          modeKey,
          exec,
          target,
          info,
          config,
        );
      await this.authorize(target, info.version, exec.signal);
      this.ctx.emit(
        "fs/observed",
        target,
        { kind: "present", version: info.version },
        exec,
      );
      return value;
    } finally {
      exec.signal.removeEventListener("abort", cancel);
      await this.cache.unpin(entry);
    }
  }
  private async query(
    doc: Document,
    args: SearchArgs,
    saved: Query | undefined,
    modeKey: string,
    exec: ToolExecution,
    target: FsTarget,
    info: FsInfo,
    config: Config,
  ): Promise<SearchValue> {
    const state: Query = saved
      ? structuredClone(saved)
      : {
          phase: "native" as const,
          native: searchInput(args, this.cache),
          scope: args.scope ?? "all",
          index: 0,
        };
    const run =
      state.scope === "all" && config.ocr.enabled
        ? this.run(doc, config, "transcription")
        : undefined;
    if (run) {
      if (!saved)
        for (const [hash, result] of run.results)
          if (result.state === "failed") run.results.delete(hash);
      this.start(doc, run, target, info, exec);
    }
    let value: SearchValue;
    if (state.phase === "native") {
      value = await search(
        this.cache,
        doc.entry,
        state.native,
        exec.signal,
        1600,
      );
      if (value.next_search_args) {
        const id = value.next_search_args.cursor;
        state.native = this.cache.getCursor(
          id,
          doc.entry.session,
          doc.entry.key,
          "search",
        ).state as SearchState;
        this.cache.discardCursor(id);
      } else state.phase = "images";
      for (const result of value.results)
        result.result_id = result.location.block!;
    } else {
      value = {
        file: doc.entry.file,
        format: "docx",
        document_revision: doc.entry.revision,
        effective_scope: "block",
        keywords: state.native.keywords,
        require_all: state.native.require_all,
        results: [],
        scan_complete: false,
        has_more: null,
        next_search_args: null,
        partial: doc.entry.meta.partial,
        extraction_coverage: doc.entry.meta.extraction_coverage,
        excluded_content: ["generated_description", "mixed_or_unknown"],
        warnings: [...doc.entry.meta.warnings],
      };
      await this.wait(run, config.progressive.waitMs, exec.signal);
      const scopes = [...doc.scopes.keys()],
        deadline = Date.now() + config.search.scanTimeoutMs;
      while (
        run &&
        state.index < scopes.length &&
        value.results.length < config.search.maxResults &&
        Date.now() < deadline
      ) {
        const scope = scopes[state.index]!;
        if (
          doc.images.some((i) => i.scope === scope && !run.results.has(i.hash))
        )
          break;
        const snapshot = state.imageEntry
          ? this.cache.entries.get(state.imageEntry)
          : await this.snapshot(doc, scope, run, config);
        if (!snapshot || snapshot.expired)
          fail("DOCUMENT_REVISION_EXPIRED", "图片扫描快照已过期，请重新搜索。");
        snapshot.pins++;
        try {
          const result = await search(
            this.cache,
            snapshot,
            state.imageState ??
              searchInput(
                {
                  file_path: args.file_path,
                  keywords: state.native.keywords,
                  require_all: state.native.require_all,
                },
                this.cache,
              ),
            exec.signal,
            1600,
          );
          // One Word block is one search scope. Preserve a continuation for pathological long blocks.
          if (result.next_search_args) {
            const id = result.next_search_args.cursor;
            state.imageState = this.cache.getCursor(
              id,
              snapshot.session,
              snapshot.key,
              "search",
            ).state as SearchState;
            state.imageEntry = snapshot.key;
            this.cache.discardCursor(id);
            return this.finishSearch(doc, value, state, run, modeKey, config);
          }
          for (const item of result.results) {
            item.result_id = scope;
            item.update = true;
            for (const s of item.snippets)
              s.read_args = {
                file_path: doc.entry.file,
                block_id: scope,
                image_mode: "transcription",
                expected_revision: doc.entry.revision,
              };
            if (
              jsonBytes({ ...value, results: [...value.results, item] }) >
              config.search.maxBytes - 1600
            ) {
              if (value.results.length)
                return this.finishSearch(
                  doc,
                  value,
                  state,
                  run,
                  modeKey,
                  config,
                );
              // Existing search truncation leaves room using a reserved metadata budget below.
              while (
                item.snippets.length > 1 &&
                jsonBytes({ ...value, results: [item] }) >
                  config.search.maxBytes - 1600
              ) {
                item.snippets.pop();
                item.snippets_truncated = true;
              }
              while (
                item.snippets[0] &&
                jsonBytes({ ...value, results: [item] }) >
                  config.search.maxBytes - 1600
              ) {
                item.snippets[0].text = item.snippets[0].text.slice(
                  0,
                  Math.floor(item.snippets[0].text.length / 2),
                );
                item.snippets_truncated = true;
                if (!item.snippets[0].text)
                  fail(
                    "DOCUMENT_OUTPUT_BUDGET_TOO_SMALL",
                    "命中元数据超过预算。",
                  );
              }
            }
            value.results.push(item);
          }
          state.index++;
          delete state.imageEntry;
          delete state.imageState;
        } finally {
          await this.cache.unpin(snapshot);
        }
      }
    }
    return this.finishSearch(doc, value, state, run, modeKey, config);
  }
  private finishSearch(
    doc: Document,
    value: SearchValue,
    state: Query,
    run: Run | undefined,
    modeKey: string,
    config: Config,
  ): SearchValue {
    const progress = this.progress(doc, run, state.scope, config);
    const done =
      state.phase === "images" && (!run || state.index >= doc.scopes.size);
    value.scan_complete = done;
    value.has_more = done ? false : null;
    value.next_search_args = done
      ? null
      : {
          file_path: doc.entry.file,
          cursor: this.token(
            doc,
            modeKey,
            { kind: "search", query: state },
            config,
          ),
        };
    value.image_progress = progress;
    value.search_scope = state.scope;
    value.extraction_complete =
      progress.pending === 0 &&
      progress.failed === 0 &&
      progress.skipped === 0 &&
      !doc.entry.meta.partial &&
      doc.entry.meta.extraction_coverage === "no_known_gaps";
    value.partial ||=
      progress.pending > 0 || progress.failed > 0 || progress.skipped > 0;
    if (value.partial) value.extraction_coverage = "known_gaps";
    value.warnings = [...value.warnings];
    if (progress.pending)
      value.warnings.push(
        "图片尚未全部识别，当前零命中不代表全文不存在；复制 next_search_args 继续。",
      );
    if (progress.failed)
      value.warnings.push(
        "部分图片识别失败，新建搜索只重试失败或尚未完成部分。错误类别：" +
          [
            ...new Set(
              [...(run?.results.values() ?? [])]
                .filter((r) => r.state === "failed")
                .map((r) => r.code || "UNKNOWN"),
            ),
          ]
            .slice(0, 5)
            .join("、"),
      );
    if (progress.skipped) value.warnings.push("当前搜索未覆盖图片文字。");
    if (run?.warning) value.warnings.push(run.warning);
    if ([...(run?.results.values() ?? [])].some((r) => r.warning)) {
      value.warnings.push(
        "部分图片已切片，重叠文字可能重复，跨切片词句检索不保证连续。",
      );
      value.extraction_coverage = "unknown";
      value.extraction_complete = false;
    }
    if (jsonBytes(value) > config.search.maxBytes)
      fail(
        "DOCUMENT_OUTPUT_BUDGET_TOO_SMALL",
        "搜索状态超过响应预算，请提高搜索返回上限。",
      );
    return value;
  }
  private async read(
    doc: Document,
    args: ReadArgs,
    saved: Extract<State, { kind: "read" }> | undefined,
    modeKey: string,
    exec: ToolExecution,
    target: FsTarget,
    info: FsInfo,
    config: Config,
  ): Promise<ReadValue> {
    let entry = doc.entry,
      run: Run | undefined;
    let refreshImage = saved?.refreshImage ?? false;
    const imageId = saved?.imageId ?? args.image_id;
    const scope =
      saved?.imageScope ??
      args.block_id ??
      (imageId ? doc.images.find((i) => i.id === imageId)?.scope : undefined);
    if ((args.block_id || args.image_id) && !scope)
      fail("DOCUMENT_LOCATION_INVALID", "图片或块位置不存在。");
    if (saved) {
      const found = this.cache.entries.get(saved.entryKey);
      if (!found || found.expired)
        fail("DOCUMENT_REVISION_EXPIRED", "读取快照已过期，请重新定位。");
      entry = found;
      if (scope && saved.mode) run = this.run(doc, config, saved.mode);
    } else if (scope) {
      if (!doc.scopes.has(scope))
        fail("DOCUMENT_LOCATION_INVALID", "块位置不存在。");
      const mode = args.image_mode ?? "transcription";
      const enabled =
        mode === "description" ? config.vision.enabled : config.ocr.enabled;
      if (imageId && !enabled)
        fail(
          "DOCUMENT_VISION_DISABLED",
          "指定图片的识别模式未启用，请在插件配置中启用后重试。",
        );
      if (enabled) {
        run = this.run(doc, config, mode);
        const hashes = doc.images
          .filter((i) => (imageId ? i.id === imageId : i.scope === scope))
          .map((i) => i.hash);
        if (imageId) {
          await this.directImage(
            doc,
            run,
            hashes[0]!,
            target,
            info,
            exec,
            config,
          );
          refreshImage = false;
        } else {
          this.start(doc, run, target, info, exec, hashes);
          await this.wait(run, config.progressive.waitMs, exec.signal, hashes);
          refreshImage = hashes.some((hash) => !run!.results.has(hash));
        }
      }
      entry = await this.snapshot(doc, scope, run, config);
    }
    entry.pins++;
    try {
      const value = await readWindow(
        this.cache,
        entry,
        args,
        saved?.state,
        1800,
      );
      value.document_revision = doc.entry.revision;
      // Snapshot continuations never reassemble a block while new OCR is arriving.
      if (value.next_read_args) {
        const next = value.next_read_args;
        let state: ReadState;
        if (next.cursor) {
          state = this.cache.getCursor(
            next.cursor,
            entry.session,
            entry.key,
            "read",
          ).state as ReadState;
          this.cache.discardCursor(next.cursor);
        } else {
          const { byteAtLine } = await import("./cache.js");
          state = {
            position: await byteAtLine(entry, next.offset!),
            line: next.offset!,
            limit: next.limit!,
          };
        }
        value.next_read_args = {
          file_path: doc.entry.file,
          cursor: this.token(
            doc,
            modeKey,
            {
              kind: "read",
              entryKey: entry.key,
              state,
              imageScope: scope,
              imageId,
              refreshImage,
              mode: run?.mode,
            },
            config,
          ),
        };
      }
      const selected =
        args.image_offset !== undefined
          ? doc.images.slice(args.image_offset)
          : imageId
            ? doc.images.filter((i) => i.id === imageId)
            : scope
              ? doc.images.filter((i) => i.scope === scope)
              : doc.images.filter(
                  (i) =>
                    i.line >= value.offset &&
                    i.line < value.offset + Math.max(1, value.returnedLines),
                );
      value.images = selected.slice(0, 12).map((i) => ({
        id: i.id,
        block_id: i.scope,
        status: run?.results.get(i.hash)?.state ?? "pending",
        read_args: {
          file_path: doc.entry.file,
          image_id: i.id,
          image_mode: config.vision.enabled ? "description" : "transcription",
          expected_revision: doc.entry.revision,
        },
      }));
      value.image_progress = this.progress(doc, run, "all", config);
      if (doc.images.length) {
        value.partial = true;
        value.extraction_coverage = "known_gaps";
        value.warnings = [
          ...value.warnings,
          "正文行号固定，图片文字与语义说明通过 images 中的 read_args 按需读取；正文 eof 不代表图片处理完成。",
        ];
      }
      if (
        scope &&
        run &&
        (refreshImage || selected.some((i) => !run!.results.has(i.hash))) &&
        !value.next_read_args
      )
        value.next_read_args = {
          file_path: doc.entry.file,
          ...(imageId ? { image_id: imageId } : { block_id: scope }),
          image_mode: run.mode,
          expected_revision: doc.entry.revision,
        };
      if (args.image_offset !== undefined) {
        value.content = "";
        value.returnedLines = 0;
        value.nextOffset = null;
        value.eof = true;
        value.next_read_args = null;
      }
      const addNextImages = () => {
        const next = selected[value.images!.length];
        value.next_images_args = next
          ? {
              file_path: doc.entry.file,
              image_offset: doc.images.indexOf(next),
              expected_revision: doc.entry.revision,
            }
          : null;
      };
      addNextImages();
      while (jsonBytes(value) > config.read.maxBytes && value.images.length) {
        value.images.pop();
        addNextImages();
      }
      if (
        jsonBytes(value) > config.read.maxBytes ||
        (selected.length && !value.images.length)
      )
        fail(
          "DOCUMENT_OUTPUT_BUDGET_TOO_SMALL",
          "读取状态超过响应预算，请提高读取返回上限。",
        );
      return value;
    } finally {
      await this.cache.unpin(entry);
    }
  }
  private async remove(key: string, doc: Document): Promise<void> {
    for (const run of doc.runs.values()) {
      run.controller?.abort();
      for (const flight of run.direct.values()) flight.controller.abort();
    }
    await Promise.allSettled(
      [...doc.runs.values()].flatMap((r) => [
        r.active,
        ...[...r.direct.values()].map((f) => f.done),
      ]),
    );
    await rm(doc.directory, { recursive: true, force: true });
    this.documents.delete(key);
    for (const [id, token] of this.tokens)
      if (token.key === key) this.tokens.delete(id);
  }
  async sweep(session?: string): Promise<void> {
    if (session)
      for (const flight of this.nativeFlights.values())
        if (flight.session === session) flight.controller.abort();
    for (const [key, promise] of this.documents) {
      const doc = await promise.catch(() => undefined);
      if (
        doc &&
        (session
          ? doc.entry.session === session
          : !this.cache.entries.has(key) || doc.entry.expired)
      )
        await this.remove(key, doc);
    }
    for (const [id, t] of this.tokens)
      if (
        session
          ? t.session === session
          : !this.documents.has(t.key) ||
            Date.now() - t.time > this.cache.config.cache.ttlMinutes * 60000
      )
        this.tokens.delete(id);
  }
  async dispose(): Promise<void> {
    this.lifetime.abort();
    for (const [key, p] of this.documents) {
      const d = await p.catch(() => undefined);
      if (d) await this.remove(key, d);
    }
    this.tokens.clear();
  }
}
