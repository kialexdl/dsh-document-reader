import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { visualGroups, selectedAvailable, } from "./model-options.js";
import { modelCatalogRemote } from "../model-catalog-contract.js";
const labels = {
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
};
function validate(value, groups) {
    const v = value.vision;
    const source = v.source === "auto" ? (v.baseURL ? "standalone" : "dsh") : v.source;
    if (v.enabled || value.ocr.enabled) {
        if (source === "dsh" && !selectedAvailable(groups, v.provider, v.model))
            return "请选择当前可用且声明支持图片的服务商和模型。";
        if (source === "standalone") {
            try {
                const u = new URL(v.baseURL);
                if (!["http:", "https:"].includes(u.protocol) ||
                    u.username ||
                    u.password ||
                    u.search ||
                    u.hash)
                    throw Error();
            }
            catch {
                return "独立服务地址必须是有效地址，不能包含凭据或查询参数。";
            }
            if (!v.model.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.apiKeyEnv))
                return "请填写独立模型名称和有效的密钥环境变量名称。";
        }
    }
    for (const [section, fields] of Object.entries(value))
        for (const [key, n] of Object.entries(fields)) {
            if (typeof n !== "number")
                continue;
            if (!Number.isFinite(n) ||
                n < (key === "maxRetries" ? 0 : 1) ||
                (!key.endsWith("MiB") &&
                    key !== "ttlMinutes" &&
                    key !== "partialTtlMinutes" &&
                    key !== "retentionDays" &&
                    !Number.isInteger(n)))
                return `${labels[key] ?? section + "." + key}的数值无效。`;
        }
    if (value.read.maxBytes < 4096 || value.search.maxBytes < 4096)
        return "单次返回字节上限至少为 4096。";
    const c = value.cache;
    if (c.memoryEntryMiB > c.memoryTotalMiB ||
        c.memoryTotalMiB > c.maxTotalMiB ||
        c.partialTtlMinutes > c.ttlMinutes)
        return "缓存应满足单份内存 ≤ 总内存 ≤ 总配额，不完整结果有效期 ≤ 缓存有效期。";
    return undefined;
}
export function ReaderSettings({ form, ctx, }) {
    const [draft, setDraft] = useState();
    const [groups, setGroups] = useState([]);
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
            if (!mounted.current || token !== generation.current)
                return;
            if (!result.ok) {
                const code = /^[a-zA-Z0-9_./-]{1,100}$/.test(result.error.code)
                    ? result.error.code
                    : "unknown";
                setGroups([]);
                setCatalogStatus(`模型能力列表请求失败（${code}）。请确认后端插件已更新并重启，再刷新重试。`);
                return;
            }
            setGroups(visualGroups(result.value.groups));
            setCatalogStatus(result.value.failures.length
                ? "部分服务商或模型能力读取失败，可刷新重试。"
                : "仅列出已配置模型；模型需在输入类型中声明支持图片。");
        }
        catch {
            if (!mounted.current || token !== generation.current)
                return;
            setGroups([]);
            setCatalogStatus("模型能力接口未就绪或连接失败，无法读取服务商列表。请重新加载页面；此提示不表示 DSH 没有配置模型。");
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
        return _jsx("p", { children: "\u914D\u7F6E\u5C1A\u4E0D\u53EF\u7528\uFF0C\u8BF7\u786E\u8BA4\u63D2\u4EF6\u5DF2\u542F\u7528\uFF0C\u5E76\u4F7F\u7528 DSH \u672C\u5730\u914D\u7F6E\u7F16\u8F91\u9875\u9762\u3002" });
    const current = form.state.value;
    const value = draft?.value ?? current;
    const conflict = !!draft && draft.revision !== form.state.revision;
    const source = value.vision.source === "auto"
        ? value.vision.baseURL
            ? "standalone"
            : "dsh"
        : value.vision.source;
    const active = value.vision.enabled || value.ocr.enabled;
    const selected = groups.find((p) => p.id === value.vision.provider);
    const validModel = selectedAvailable(groups, value.vision.provider, value.vision.model);
    const error = validate(value, groups);
    const locked = saving || !form.state.writable;
    function change(section, key, next) {
        setDraft((old) => {
            const copy = structuredClone(old?.value ?? current);
            copy[section][key] = next;
            if (section === "vision" && key === "provider")
                copy.vision.model = "";
            return {
                value: copy,
                revision: old ? old.revision : form.state.revision,
            };
        });
        setNotice("");
    }
    async function save() {
        if (!draft || conflict || error || locked)
            return;
        setSaving(true);
        setNotice("");
        try {
            const ops = Object.entries(draft.value)
                .filter(([key, val]) => JSON.stringify(val) !==
                JSON.stringify(current[key]))
                .map(([key, val]) => ({
                op: "set",
                path: [key],
                value: JSON.parse(JSON.stringify(val)),
            }));
            const accepted = await form.mutate(ops, draft.revision);
            if (!mounted.current)
                return;
            if (accepted) {
                setDraft(undefined);
                setNotice("已保存。新的文档转换使用新配置；修改模型后请重新读取或搜索。");
            }
            else
                setNotice("保存被拒绝，配置可能已被其他窗口修改，请重新加载后再试。");
        }
        catch {
            if (mounted.current)
                setNotice("保存失败，请检查连接并重新加载配置。");
        }
        finally {
            if (mounted.current)
                setSaving(false);
        }
    }
    const field = (section, key) => {
        const item = value[section][key];
        return (_jsxs("label", { children: [_jsx("span", { children: labels[key] ?? key }), typeof item === "boolean" ? (_jsx("input", { type: "checkbox", checked: item, onChange: (e) => change(section, key, e.target.checked) })) : key === "prompt" || key === "ocrPrompt" ? (_jsx("textarea", { rows: 5, value: String(item), onChange: (e) => change(section, key, e.target.value) })) : (_jsx("input", { type: typeof item === "number" ? "number" : "text", value: typeof item === "number" && !Number.isFinite(item)
                        ? ""
                        : String(item), min: key === "maxRetries" ? 0 : 1, step: key.endsWith("MiB") || key.endsWith("Minutes") ? "any" : 1, onChange: (e) => change(section, key, typeof item === "number"
                        ? e.target.value === ""
                            ? NaN
                            : Number(e.target.value)
                        : e.target.value) }))] }, key));
    };
    return (_jsxs("div", { "data-document-reader-settings": true, children: [_jsx("style", { children: `[data-document-reader-settings]{max-width:850px;color:inherit;line-height:1.6}[data-document-reader-settings] fieldset{border:0;padding:0;margin:0}[data-document-reader-settings] label{display:flex;flex-direction:column;gap:6px;margin:14px 0}[data-document-reader-settings] label.toggle{flex-direction:row;align-items:center;gap:10px}[data-document-reader-settings] input:not([type=checkbox]),[data-document-reader-settings] select,[data-document-reader-settings] textarea{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:7px;padding:9px 12px}[data-document-reader-settings] select option{color:CanvasText;background:Canvas}[data-document-reader-settings] button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:7px;padding:7px 15px;cursor:pointer}[data-document-reader-settings] button:disabled{opacity:.45;cursor:default}[data-document-reader-settings] details{border-top:1px solid color-mix(in srgb,currentColor 18%,transparent);margin-top:20px;padding-top:14px}[data-document-reader-settings] summary{cursor:pointer;font-weight:600}[data-document-reader-settings] .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:0 20px}[data-document-reader-settings] .hint{opacity:.75;font-size:.92em}[data-document-reader-settings] .notice{border-left:3px solid currentColor;padding:8px 12px;margin:12px 0}[data-document-reader-settings] .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}` }), _jsx("p", { children: "\u9009\u62E9\u4E13\u7528\u4E8E\u6587\u6863\u56FE\u7247\u8BC6\u522B\u7684\u6A21\u578B\u3002\u4E3B\u4F1A\u8BDD\u5207\u6362\u6A21\u578B\u4E0D\u4F1A\u6539\u53D8\u8FD9\u91CC\u7684\u9009\u62E9\u3002" }), _jsx("p", { className: "hint", children: "Word \u9ED8\u8BA4\u5148\u8FD4\u56DE\u6B63\u6587\uFF0C\u518D\u901A\u8FC7\u7EED\u67E5\u5206\u6279\u8865\u5168\u56FE\u7247\u3002\u542F\u7528\u6301\u4E45\u7F13\u5B58\u540E\uFF0C\u6B63\u6587\u3001\u5185\u5D4C\u56FE\u7247\u548C\u8BC6\u522B\u7ED3\u679C\u4FDD\u5B58\u5728\u5F53\u524D\u7528\u6237\u672C\u673A\uFF1B\u53D7\u78C1\u76D8\u914D\u989D\u548C\u4FDD\u7559\u671F\u63A7\u5236\u3002\u6539\u53D8\u540C\u540D\u6A21\u578B\u7684\u5B9E\u9645\u540E\u7AEF\u65F6\uFF0C\u8BF7\u4FEE\u6539\u201C\u56FE\u7247\u7F13\u5B58\u7248\u672C\u201D\u3002" }), !form.state.writable && (_jsx("p", { className: "notice", children: "\u5F53\u524D\u8FDE\u63A5\u4E0D\u5141\u8BB8\u5199\u5165\u914D\u7F6E\uFF0C\u8BF7\u5728 DSH \u5141\u8BB8\u7F16\u8F91\u914D\u7F6E\u7684\u672C\u5730\u9875\u9762\u6253\u5F00\u3002" })), _jsxs("fieldset", { disabled: locked, children: [_jsxs("label", { className: "toggle", children: [_jsx("input", { type: "checkbox", checked: value.vision.enabled, onChange: (e) => change("vision", "enabled", e.target.checked) }), "\u751F\u6210\u56FE\u7247\u5185\u5BB9\u8BF4\u660E\uFF08Word \u6309\u9700\u8BFB\u53D6\u56FE\u7247\u65F6\u8C03\u7528\uFF09"] }), _jsxs("label", { className: "toggle", children: [_jsx("input", { type: "checkbox", checked: value.ocr.enabled, onChange: (e) => change("ocr", "enabled", e.target.checked) }), "\u8BC6\u522B\u56FE\u7247\u6587\u5B57\uFF08\u53EF\u7528\u4E8E\u5173\u952E\u8BCD\u641C\u7D22\uFF09"] }), _jsxs("label", { children: [_jsx("span", { children: "\u89C6\u89C9\u670D\u52A1\u6765\u6E90" }), _jsxs("select", { value: source, onChange: (e) => change("vision", "source", e.target.value), children: [_jsx("option", { value: "dsh", children: "\u4F7F\u7528 DSH \u5DF2\u914D\u7F6E\u6A21\u578B\uFF08\u63A8\u8350\uFF09" }), _jsx("option", { value: "standalone", children: "\u72EC\u7ACB\u914D\u7F6E\uFF08\u517C\u5BB9\u65E7\u7248\uFF09" })] })] }), source === "dsh" ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid", children: [_jsxs("label", { children: [_jsx("span", { children: "\u670D\u52A1\u5546" }), _jsxs("select", { value: value.vision.provider, onChange: (e) => change("vision", "provider", e.target.value), children: [_jsx("option", { value: "", children: "\u8BF7\u9009\u62E9\u670D\u52A1\u5546" }), value.vision.provider && !selected && (_jsxs("option", { value: value.vision.provider, disabled: true, children: [value.vision.provider, "\uFF08\u5F53\u524D\u4E0D\u53EF\u7528\uFF09"] })), groups.map((p) => (_jsxs("option", { value: p.id, children: [p.name, p.models.length ? "" : "（无图片模型）"] }, p.id)))] })] }), _jsxs("label", { children: [_jsx("span", { children: "\u89C6\u89C9\u6A21\u578B" }), _jsxs("select", { value: value.vision.model, onChange: (e) => change("vision", "model", e.target.value), children: [_jsx("option", { value: "", children: "\u8BF7\u9009\u62E9\u652F\u6301\u56FE\u7247\u7684\u6A21\u578B" }), value.vision.model && !validModel && (_jsxs("option", { value: value.vision.model, disabled: true, children: [value.vision.model, "\uFF08\u5F53\u524D\u4E0D\u53EF\u7528\uFF09"] })), selected?.models.map((m) => (_jsxs("option", { value: m.id, children: [m.name, " \u00B7 ", m.id] }, m.id)))] })] })] }), _jsx("p", { className: "hint", children: catalogStatus }), _jsx("button", { type: "button", onClick: () => void refresh(), children: "\u5237\u65B0\u6A21\u578B\u5217\u8868" }), _jsx("p", { className: "hint", children: "\u670D\u52A1\u5730\u5740\u3001\u5BC6\u94A5\u3001\u534F\u8BAE\u548C\u8BF7\u6C42\u5934\u6CBF\u7528\u6240\u9009\u670D\u52A1\u5546\u3002\u5982\u9700\u4FEE\u6539\uFF0C\u8BF7\u524D\u5F80\u300C\u8BBE\u7F6E \u2192 \u6A21\u578B\u300D\u3002\u56FE\u7247\u80FD\u529B\u4EE5\u8BE5\u9875\u7684\u8F93\u5165\u7C7B\u578B\u58F0\u660E\u4E3A\u51C6\u3002" }), _jsx("p", { className: "hint", children: "DSH \u6A21\u5F0F\u4F1A\u5C06\u5F85\u8BC6\u522B\u56FE\u7247\u4FDD\u5B58\u4E3A DSH \u9644\u4EF6\uFF1B\u9644\u4EF6\u4FDD\u7559\u7531 DSH \u7BA1\u7406\uFF0C\u4E0D\u968F\u672C\u63D2\u4EF6\u4E34\u65F6\u7F13\u5B58\u6E05\u7406\u3002" })] })) : (_jsxs(_Fragment, { children: [_jsxs("label", { children: [_jsx("span", { children: "\u670D\u52A1\u57FA\u7840\u5730\u5740" }), _jsx("input", { value: value.vision.baseURL, onChange: (e) => change("vision", "baseURL", e.target.value) })] }), _jsxs("label", { children: [_jsx("span", { children: "\u5BC6\u94A5\u73AF\u5883\u53D8\u91CF\u540D\u79F0\uFF08\u4E0D\u586B\u5199\u5BC6\u94A5\u672C\u8EAB\uFF09" }), _jsx("input", { value: value.vision.apiKeyEnv, onChange: (e) => change("vision", "apiKeyEnv", e.target.value) })] }), _jsxs("label", { children: [_jsx("span", { children: "\u6A21\u578B\u540D\u79F0" }), _jsx("input", { value: value.vision.model, onChange: (e) => change("vision", "model", e.target.value) })] })] })), !active && (_jsx("p", { className: "hint", children: "\u56FE\u7247\u5904\u7406\u5DF2\u5173\u95ED\uFF0C\u6587\u6863\u539F\u751F\u6587\u5B57\u4ECD\u53EF\u8BFB\u53D6\u548C\u641C\u7D22\u3002" })), _jsxs("details", { children: [_jsx("summary", { children: "\u89C6\u89C9\u9AD8\u7EA7\u8BBE\u7F6E" }), _jsx("div", { className: "grid", children: [
                                    "requestTimeoutMs",
                                    "maxRetries",
                                    "maxCallsPerDocument",
                                    "maxImageMiB",
                                    "maxResponseChars",
                                ].map((key) => field("vision", key)) }), field("vision", "prompt")] }), Object.entries(titles).map(([section, title]) => (_jsxs("details", { children: [_jsx("summary", { children: title }), _jsx("div", { className: "grid", children: Object.keys(value[section]).map((key) => field(section, key)) })] }, section)))] }), conflict && (_jsx("p", { className: "notice", role: "alert", children: "\u914D\u7F6E\u5DF2\u88AB\u5176\u4ED6\u7A97\u53E3\u4FEE\u6539\u3002\u8BF7\u70B9\u51FB\u201C\u91CD\u65B0\u52A0\u8F7D\u914D\u7F6E\u201D\uFF0C\u518D\u91CD\u65B0\u4FEE\u6539\u3002" })), error && (_jsx("p", { className: "notice", role: "alert", children: error })), notice && (_jsx("p", { className: "notice", role: "status", children: notice })), _jsxs("div", { className: "actions", children: [_jsx("button", { type: "button", disabled: !draft || locked || !!error || conflict, onClick: () => void save(), children: saving ? "正在保存…" : "保存配置" }), _jsx("button", { type: "button", disabled: saving, onClick: () => {
                            setDraft(undefined);
                            setNotice("");
                        }, children: "\u91CD\u65B0\u52A0\u8F7D\u914D\u7F6E" })] })] }));
}
export const inject = ["slots", "locale", "remote", "configForms"];
export async function apply(ctx) {
    await ctx.remote.$mount(modelCatalogRemote);
    // Mount first, then consume the namespace in an explicitly dependent scope.
    // Adding it to the outer inject list would deadlock its own registration.
    ctx.inject(["remote.documentReaderModels"], (child) => {
        child.slots.inject("plugins.row.config", () => child.slots.register({
            name: "plugins.row.config",
            key: "dsh-document-reader#document-reader",
        }, ({ view, form }) => view === "summary" ? ("文档读取、关键词搜索及 DSH 视觉模型配置") : (_jsx(ReaderSettings, { ctx: child, view: view, form: form }))));
    });
}
//# sourceMappingURL=index.js.map