/** Deployment controls; search semantics are deliberately not model parameters. */
import Schema from "@deepseek-ai/schemastery";
import { isAbsolute } from "node:path";

export interface Config {
  python: {
    executable: string;
    startupTimeoutMs: number;
    terminateGraceMs: number;
  };
  conversion: {
    timeoutMs: number;
    maxConcurrent: number;
    maxSourceMiB: number;
    maxResultMiB: number;
    sourceMemoryMiB: number;
    maxArchiveMiB: number;
    maxArchiveEntries: number;
    maxMapRecords: number;
    pdfDpi: number;
  };
  read: { maxLines: number; maxBytes: number };
  search: {
    maxResults: number;
    maxBytes: number;
    maxKeywords: number;
    maxKeywordChars: number;
    snippetChars: number;
    scanTimeoutMs: number;
  };
  cache: {
    memoryEntryMiB: number;
    memoryTotalMiB: number;
    maxTotalMiB: number;
    ttlMinutes: number;
    partialTtlMinutes: number;
    sweepIntervalSeconds: number;
    maxCursors: number;
  };
  vision: {
    enabled: boolean;
    source: "auto" | "dsh" | "standalone";
    provider: string;
    maxImageMiB: number;
    maxResponseChars: number;
    baseURL: string;
    apiKeyEnv: string;
    model: string;
    requestTimeoutMs: number;
    maxRetries: number;
    maxCallsPerDocument: number;
    prompt: string;
  };
  ocr: { enabled: boolean };
  progressive: {
    enabled: boolean;
    imageConcurrency: number;
    batchImages: number;
    waitMs: number;
    tilePixels: number;
    tileOverlap: number;
    maxTiles: number;
    maxImagePixels: number;
    persistent: boolean;
    directory: string;
    diskMiB: number;
    retentionDays: number;
    ocrPrompt: string;
    cacheVersion: string;
  };
}
const pos = (value: number) => Schema.number().min(1).default(value);
const integer = (value: number) => pos(value).step(1);
export const Config: Schema<Config> = Schema.object({
  python: Schema.object({
    executable: Schema.string().default(""),
    startupTimeoutMs: integer(10000),
    terminateGraceMs: integer(3000),
  }),
  conversion: Schema.object({
    timeoutMs: integer(300000),
    maxConcurrent: integer(1),
    maxSourceMiB: pos(512),
    maxResultMiB: pos(512),
    sourceMemoryMiB: pos(8),
    maxArchiveMiB: pos(1024),
    maxArchiveEntries: integer(20000),
    maxMapRecords: integer(100000),
    pdfDpi: integer(160),
  }),
  read: Schema.object({ maxLines: integer(2000), maxBytes: integer(51200) }),
  search: Schema.object({
    maxResults: integer(20),
    maxBytes: integer(51200),
    maxKeywords: integer(16),
    maxKeywordChars: integer(256),
    snippetChars: integer(240),
    scanTimeoutMs: integer(5000),
  }),
  cache: Schema.object({
    memoryEntryMiB: pos(1),
    memoryTotalMiB: pos(16),
    maxTotalMiB: pos(256),
    ttlMinutes: pos(30),
    partialTtlMinutes: pos(5),
    sweepIntervalSeconds: integer(60),
    maxCursors: integer(256),
  }),
  vision: Schema.object({
    enabled: Schema.boolean().default(false),
    source: Schema.union(["auto", "dsh", "standalone"]).default("auto"),
    provider: Schema.string().default(""),
    maxImageMiB: pos(20),
    maxResponseChars: integer(200000),
    baseURL: Schema.string().default(""),
    apiKeyEnv: Schema.string().default("VISION_API_KEY"),
    model: Schema.string().default(""),
    requestTimeoutMs: integer(60000),
    maxRetries: Schema.number().min(0).step(1).default(1),
    maxCallsPerDocument: integer(100),
    prompt: Schema.string().default(""),
  }),
  ocr: Schema.object({ enabled: Schema.boolean().default(false) }),
  progressive: Schema.object({
    enabled: Schema.boolean().default(true),
    imageConcurrency: integer(2).max(8),
    batchImages: integer(16).max(128),
    waitMs: integer(1000).max(10000),
    tilePixels: integer(1800).min(256).max(4096),
    tileOverlap: integer(96).max(512),
    maxTiles: integer(64).max(256),
    maxImagePixels: integer(100000000),
    persistent: Schema.boolean().default(true),
    directory: Schema.string().default(""),
    diskMiB: pos(1024),
    retentionDays: pos(7),
    ocrPrompt: Schema.string().default(""),
    cacheVersion: Schema.string().default("1"),
  }),
});
export function validateConfig(config: Config): Config {
  const p = config.progressive;
  if (p.tileOverlap >= p.tilePixels / 2)
    throw new Error("图片切片重叠必须小于切片边长的一半。");
  if (p.directory && !isAbsolute(p.directory))
    throw new Error("持久缓存目录必须为绝对路径。");
  const c = config.cache;
  if (
    c.memoryEntryMiB > c.memoryTotalMiB ||
    c.memoryTotalMiB > c.maxTotalMiB ||
    c.partialTtlMinutes > c.ttlMinutes
  )
    throw new Error(
      "缓存配置要求 memoryEntry ≤ memoryTotal ≤ maxTotal，partialTTL ≤ TTL。",
    );
  if (config.python.executable && !isAbsolute(config.python.executable))
    throw new Error(
      "python.executable 必须是解释器的绝对路径，不能填写 shell 命令。",
    );
  if (Math.min(config.read.maxBytes, config.search.maxBytes) < 4096)
    throw new Error("读取/搜索 maxBytes 至少为 4096。");
  if (
    (config.vision.enabled || config.ocr.enabled) &&
    visionSource(config) === "standalone"
  ) {
    const v = config.vision;
    let url: URL;
    try {
      url = new URL(v.baseURL);
    } catch {
      throw new Error("VISION_CONFIG_INVALID: 请配置视觉 baseURL。");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !v.model ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.apiKeyEnv) ||
      !process.env[v.apiKeyEnv]
    )
      throw new Error(
        "VISION_CONFIG_INVALID: 检查 baseURL、model 及 apiKeyEnv 指向的环境变量。",
      );
  }
  return config;
}
export const MiB = 1024 * 1024;

/** Legacy endpoints stay independent until the user explicitly changes source. */
export function visionSource(config: Config): "dsh" | "standalone" {
  return config.vision.source === "auto"
    ? config.vision.baseURL
      ? "standalone"
      : "dsh"
    : config.vision.source;
}
export type LiveConfig = { [K in keyof Config]: { get(): Config[K] } };
// Keep the plain schema for snapshots and tests. Only the plugin's public
// schema wraps the fixed section paths in Loader-owned volatile references.
export const PluginConfig = Schema.object(
  Object.fromEntries(
    Object.entries(Config.dict!).map(([key, schema]) => [
      key,
      schema.volatile(),
    ]),
  ),
) as unknown as Schema<LiveConfig>;
export function snapshotConfig(config: LiveConfig): Config {
  return structuredClone(
    Object.fromEntries(
      Object.entries(config).map(([key, value]) => [key, value.get()]),
    ),
  ) as unknown as Config;
}
