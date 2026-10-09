/** Native DSH plugin configuration page; no model credentials enter this bundle. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { PluginConfigViewProps } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { useEffect, useRef, useState } from "react";
import type { Config } from "../config.js";
import {
  visualGroups,
  selectedAvailable,
  type ModelGroup,
} from "./model-options.js";
import { modelCatalogRemote } from "../model-catalog-contract.js";

const labels: Record<string, string> = {
  executable: "Python 解释器绝对路径（留空自动查找）",
  startupTimeoutMs: "环境检查超时（毫秒）",
  terminateGraceMs: "进程退出宽限（毫秒）",
  timeoutMs: "单文档总超时（毫秒）",
  maxConcurrent: "最多同时转换文档数",
  maxSourceMiB: "源文件上限（MiB，兆字节）",
  maxResultMiB: "转换结果上限（MiB）",
  sourceMemoryMiB: "源文件内存缓冲（MiB）",
  maxArchiveMiB: "压缩包展开上限（MiB）",
  maxArchiveEntries: "压缩包条目上限",
  maxMapRecords: "位置记录上限",
  pdfDpi: "PDF 渲染分辨率（每英寸点数）",
  maxLines: "单次读取行数上限",
  maxBytes: "单次返回字节上限",
  maxResults: "单次搜索结果上限",
  maxKeywords: "关键词数量上限",
  maxKeywordChars: "单个关键词字符上限",
  snippetChars: "摘要字符数",
  scanTimeoutMs: "搜索扫描超时（毫秒）",
  memoryEntryMiB: "单份缓存内存（MiB）",
  memoryTotalMiB: "缓存总内存（MiB）",
  maxTotalMiB: "普通缓存总配额（MiB）",
  ttlMinutes: "缓存空闲有效期（分钟）",
  partialTtlMinutes: "不完整结果有效期（分钟）",
  sweepIntervalSeconds: "缓存清理间隔（秒）",
  maxCursors: "续读游标上限",
  requestTimeoutMs: "单次视觉请求超时（毫秒）",
  maxRetries: "失败重试次数",
  maxCallsPerDocument: "单文档视觉调用上限（包含重试）",
  maxImageMiB: "单张图片传输上限（MiB）",
  maxResponseChars: "单张图片识别输出字符上限",
  prompt: "图片语义说明提示词（Word 搜索不使用）",
  enabled: "启用 Word 渐进处理",
  imageConcurrency: "图片请求并发数（建议 2）",
  batchImages: "每批最多处理的不同图片数",
  waitMs: "续查等待图片的时间（毫秒）",
  tilePixels: "大图切片边长（像素，不缩小文字）",
  tileOverlap: "切片重叠宽度（像素）",
  maxTiles: "单张图片切片上限",
  maxImagePixels: "单张原图像素总数上限",
  persistent: "启用本机持久缓存和断点恢复",
  directory: "持久缓存绝对目录（留空使用用户缓存目录）",
  diskMiB: "持久缓存磁盘配额（MiB）",
  retentionDays: "持久缓存保留天数",
  ocrPrompt: "Word 图片文字转录提示词（留空使用内置模板）",
  cacheVersion: "图片缓存版本（修改后重新识别）",
};
const titles = {
  python: "Python 环境",
  conversion: "文档转换",
  read: "读取限制",
  search: "关键词搜索",
  cache: "缓存管理",
  progressive: "大型 Word 渐进处理与持久缓存",
} as const;
function validate(
  value: Config,
  groups: readonly ModelGroup[],
): string | undefined {
  const v = value.vision;
  const source =
    v.source === "auto" ? (v.baseURL ? "standalone" : "dsh") : v.source;
  if (v.enabled || value.ocr.enabled) {
    if (source === "dsh" && !selectedAvailable(groups, v.provider, v.model))
      return "请选择当前可用且声明支持图片的服务商和模型。";
    if (source === "standalone") {
      try {
        const u = new URL(v.baseURL);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password ||
          u.search ||
          u.hash
        )
          throw Error();
      } catch {
        return "独立服务地址必须是有效地址，不能包含凭据或查询参数。";
      }
      if (!v.model.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.apiKeyEnv))
        return "请填写独立模型名称和有效的密钥环境变量名称。";
    }
  }
  for (const [section, fields] of Object.entries(value))
    for (const [key, n] of Object.entries(fields)) {
      if (typeof n !== "number") continue;
      if (
        !Number.isFinite(n) ||
        n < (key === "maxRetries" ? 0 : 1) ||
        (!key.endsWith("MiB") &&
          key !== "ttlMinutes" &&
          key !== "partialTtlMinutes" &&
          key !== "retentionDays" &&
          !Number.isInteger(n))
      )
        return `${labels[key] ?? section + "." + key}的数值无效。`;
    }
  if (value.read.maxBytes < 4096 || value.search.maxBytes < 4096)
    return "单次返回字节上限至少为 4096。";
  const c = value.cache;
  if (
    c.memoryEntryMiB > c.memoryTotalMiB ||
    c.memoryTotalMiB > c.maxTotalMiB ||
    c.partialTtlMinutes > c.ttlMinutes
  )
    return "缓存应满足单份内存 ≤ 总内存 ≤ 总配额，不完整结果有效期 ≤ 缓存有效期。";
  return undefined;
}
export function ReaderSettings({
  form,
  ctx,
}: PluginConfigViewProps & { ctx: Context }) {
  const [draft, setDraft] = useState<{
    value: Config;
    revision: number | undefined;
  }>();
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [catalogStatus, setCatalogStatus] = useState("正在加载模型列表…");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);
  async function refresh() {
    const token = ++generation.current;
    setCatalogStatus("正在加载模型列表…");
    try {
      const result = await ctx.remote.documentReaderModels.catalog();
      if (!mounted.current || token !== generation.current) return;
      if (!result.ok) {
        const code = /^[a-zA-Z0-9_./-]{1,100}$/.test(result.error.code)
          ? result.error.code
          : "unknown";
        setGroups([]);
        setCatalogStatus(
          `模型能力列表请求失败（${code}）。请确认后端插件已更新并重启，再刷新重试。`,
        );
        return;
      }
      setGroups(visualGroups(result.value.groups));
      setCatalogStatus(
        result.value.failures.length
          ? "部分服务商或模型能力读取失败，可刷新重试。"
          : "仅列出已配置模型；模型需在输入类型中声明支持图片。",
      );
    } catch {
      if (!mounted.current || token !== generation.current) return;
      setGroups([]);
      setCatalogStatus(
        "模型能力接口未就绪或连接失败，无法读取服务商列表。请重新加载页面；此提示不表示 DSH 没有配置模型。",
      );
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const dispose = [
      ctx.remote.$on("llm/adapters-updated", () => {
        void refresh();
      }),
      ctx.remote.$on("settings/document-updated", () => {
        void refresh();
      }),
      ctx.on("connection/reset", () => {
        setDraft(undefined);
        setNotice("连接已重建，请检查最新配置。");
        void refresh();
      }),
    ];
    return () => {
      mounted.current = false;
      generation.current++;
      dispose.forEach((d) => d());
    };
  }, [ctx]);
  if (!form || form.state.status !== "ready" || !form.state.value)
    return <p>配置尚不可用，请确认插件已启用，并使用 DSH 本地配置编辑页面。</p>;
  const current = form.state.value as unknown as Config;
  const value = draft?.value ?? current;
  const conflict = !!draft && draft.revision !== form.state.revision;
  const source =
    value.vision.source === "auto"
      ? value.vision.baseURL
        ? "standalone"
        : "dsh"
      : value.vision.source;
  const active = value.vision.enabled || value.ocr.enabled;
  const selected = groups.find((p) => p.id === value.vision.provider);
  const validModel = selectedAvailable(
    groups,
    value.vision.provider,
    value.vision.model,
  );
  const error = validate(value, groups);
  const locked = saving || !form.state.writable;
  function change(
    section: keyof Config,
    key: string,
    next: string | number | boolean,
  ) {
    setDraft((old) => {
      const copy = structuredClone(old?.value ?? current);
      (copy[section] as unknown as Record<string, unknown>)[key] = next;
      if (section === "vision" && key === "provider") copy.vision.model = "";
      return {
        value: copy,
        revision: old ? old.revision : form!.state.revision,
      };
    });
    setNotice("");
  }
  async function save() {
    if (!draft || conflict || error || locked) return;
    setSaving(true);
    setNotice("");
    try {
      const ops = Object.entries(draft.value)
        .filter(
          ([key, val]) =>
            JSON.stringify(val) !==
            JSON.stringify(current[key as keyof Config]),
        )
        .map(([key, val]) => ({
          op: "set" as const,
          path: [key],
          value: JSON.parse(JSON.stringify(val)),
        }));
      const accepted = await form!.mutate(ops, draft.revision);
      if (!mounted.current) return;
      if (accepted) {
        setDraft(undefined);
        setNotice(
          "已保存。新的文档转换使用新配置；修改模型后请重新读取或搜索。",
        );
      } else
        setNotice("保存被拒绝，配置可能已被其他窗口修改，请重新加载后再试。");
    } catch {
      if (mounted.current) setNotice("保存失败，请检查连接并重新加载配置。");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  const field = (section: keyof Config, key: string) => {
    const item = (value[section] as unknown as Record<string, unknown>)[key];
    return (
      <label key={key}>
        <span>{labels[key] ?? key}</span>
        {typeof item === "boolean" ? (
          <input
            type="checkbox"
            checked={item}
            onChange={(e) => change(section, key, e.target.checked)}
          />
        ) : key === "prompt" || key === "ocrPrompt" ? (
          <textarea
            rows={5}
            value={String(item)}
            onChange={(e) => change(section, key, e.target.value)}
          />
        ) : (
          <input
            type={typeof item === "number" ? "number" : "text"}
            value={
              typeof item === "number" && !Number.isFinite(item)
                ? ""
                : String(item)
            }
            min={key === "maxRetries" ? 0 : 1}
            step={key.endsWith("MiB") || key.endsWith("Minutes") ? "any" : 1}
            onChange={(e) =>
              change(
                section,
                key,
                typeof item === "number"
                  ? e.target.value === ""
                    ? NaN
                    : Number(e.target.value)
                  : e.target.value,
              )
            }
          />
        )}
      </label>
    );
  };
  return (
    <div data-document-reader-settings>
      <style>{`[data-document-reader-settings]{max-width:850px;color:inherit;line-height:1.6}[data-document-reader-settings] fieldset{border:0;padding:0;margin:0}[data-document-reader-settings] label{display:flex;flex-direction:column;gap:6px;margin:14px 0}[data-document-reader-settings] label.toggle{flex-direction:row;align-items:center;gap:10px}[data-document-reader-settings] input:not([type=checkbox]),[data-document-reader-settings] select,[data-document-reader-settings] textarea{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:7px;padding:9px 12px}[data-document-reader-settings] select option{color:CanvasText;background:Canvas}[data-document-reader-settings] button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:7px;padding:7px 15px;cursor:pointer}[data-document-reader-settings] button:disabled{opacity:.45;cursor:default}[data-document-reader-settings] details{border-top:1px solid color-mix(in srgb,currentColor 18%,transparent);margin-top:20px;padding-top:14px}[data-document-reader-settings] summary{cursor:pointer;font-weight:600}[data-document-reader-settings] .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:0 20px}[data-document-reader-settings] .hint{opacity:.75;font-size:.92em}[data-document-reader-settings] .notice{border-left:3px solid currentColor;padding:8px 12px;margin:12px 0}[data-document-reader-settings] .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}`}</style>
      <p>选择专用于文档图片识别的模型。主会话切换模型不会改变这里的选择。</p>
      <p className="hint">
        Word
        默认先返回正文，再通过续查分批补全图片。启用持久缓存后，正文、内嵌图片和识别结果保存在当前用户本机；受磁盘配额和保留期控制。改变同名模型的实际后端时，请修改“图片缓存版本”。
      </p>
      {!form.state.writable && (
        <p className="notice">
          当前连接不允许写入配置，请在 DSH 允许编辑配置的本地页面打开。
        </p>
      )}
      <fieldset disabled={locked}>
        <label className="toggle">
          <input
            type="checkbox"
            checked={value.vision.enabled}
            onChange={(e) => change("vision", "enabled", e.target.checked)}
          />
          生成图片内容说明（Word 按需读取图片时调用）
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={value.ocr.enabled}
            onChange={(e) => change("ocr", "enabled", e.target.checked)}
          />
          识别图片文字（可用于关键词搜索）
        </label>
        <label>
          <span>视觉服务来源</span>
          <select
            value={source}
            onChange={(e) => change("vision", "source", e.target.value)}
          >
            <option value="dsh">使用 DSH 已配置模型（推荐）</option>
            <option value="standalone">独立配置（兼容旧版）</option>
          </select>
        </label>
        {source === "dsh" ? (
          <>
            <div className="grid">
              <label>
                <span>服务商</span>
                <select
                  value={value.vision.provider}
                  onChange={(e) => change("vision", "provider", e.target.value)}
                >
                  <option value="">请选择服务商</option>
                  {value.vision.provider && !selected && (
                    <option value={value.vision.provider} disabled>
                      {value.vision.provider}（当前不可用）
                    </option>
                  )}
                  {groups.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.models.length ? "" : "（无图片模型）"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>视觉模型</span>
                <select
                  value={value.vision.model}
                  onChange={(e) => change("vision", "model", e.target.value)}
                >
                  <option value="">请选择支持图片的模型</option>
                  {value.vision.model && !validModel && (
                    <option value={value.vision.model} disabled>
                      {value.vision.model}（当前不可用）
                    </option>
                  )}
                  {selected?.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {m.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="hint">{catalogStatus}</p>
            <button type="button" onClick={() => void refresh()}>
              刷新模型列表
            </button>
            <p className="hint">
              服务地址、密钥、协议和请求头沿用所选服务商。如需修改，请前往「设置
              → 模型」。图片能力以该页的输入类型声明为准。
            </p>
            <p className="hint">
              DSH 模式会将待识别图片保存为 DSH 附件；附件保留由 DSH
              管理，不随本插件临时缓存清理。
            </p>
          </>
        ) : (
          <>
            <label>
              <span>服务基础地址</span>
              <input
                value={value.vision.baseURL}
                onChange={(e) => change("vision", "baseURL", e.target.value)}
              />
            </label>
            <label>
              <span>密钥环境变量名称（不填写密钥本身）</span>
              <input
                value={value.vision.apiKeyEnv}
                onChange={(e) => change("vision", "apiKeyEnv", e.target.value)}
              />
            </label>
            <label>
              <span>模型名称</span>
              <input
                value={value.vision.model}
                onChange={(e) => change("vision", "model", e.target.value)}
              />
            </label>
          </>
        )}
        {!active && (
          <p className="hint">图片处理已关闭，文档原生文字仍可读取和搜索。</p>
        )}
        <details>
          <summary>视觉高级设置</summary>
          <div className="grid">
            {[
              "requestTimeoutMs",
              "maxRetries",
              "maxCallsPerDocument",
              "maxImageMiB",
              "maxResponseChars",
            ].map((key) => field("vision", key))}
          </div>
          {field("vision", "prompt")}
        </details>
        {Object.entries(titles).map(([section, title]) => (
          <details key={section}>
            <summary>{title}</summary>
            <div className="grid">
              {Object.keys(value[section as keyof typeof titles]).map((key) =>
                field(section as keyof Config, key),
              )}
            </div>
          </details>
        ))}
      </fieldset>
      {conflict && (
        <p className="notice" role="alert">
          配置已被其他窗口修改。请点击“重新加载配置”，再重新修改。
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          disabled={!draft || locked || !!error || conflict}
          onClick={() => void save()}
        >
          {saving ? "正在保存…" : "保存配置"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setDraft(undefined);
            setNotice("");
          }}
        >
          重新加载配置
        </button>
      </div>
    </div>
  );
}
export const inject = ["slots", "locale", "remote", "configForms"];
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(modelCatalogRemote);
  // Mount first, then consume the namespace in an explicitly dependent scope.
  // Adding it to the outer inject list would deadlock its own registration.
  ctx.inject(["remote.documentReaderModels"], (child) => {
    child.slots.inject("plugins.row.config", () =>
      child.slots.register(
        {
          name: "plugins.row.config",
          key: "dsh-document-reader#document-reader",
        },
        ({ view, form }) =>
          view === "summary" ? (
            "文档读取、关键词搜索及 DSH 视觉模型配置"
          ) : (
            <ReaderSettings ctx={child} view={view} form={form} />
          ),
      ),
    );
  });
}
