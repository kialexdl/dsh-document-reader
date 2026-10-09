import { extname } from "node:path";
import { fail } from "./errors.js";
export const formats = new Set([
    "pdf",
    "docx",
    "pptx",
    "xlsx",
    "xls",
    "csv",
    "png",
    "jpg",
    "jpeg",
]);
export function validatePath(value) {
    if (typeof value !== "string" ||
        !value.trim() ||
        value.length > 4096 ||
        /[\x00-\x1f]/u.test(value))
        fail("DOCUMENT_PATH_INVALID", "file_path 必须是非空普通文件路径。");
    const drive = /^[A-Za-z]:[\\/]/u.test(value);
    if ((!drive && /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) ||
        /^[A-Za-z]:[^\\/]/u.test(value))
        fail("DOCUMENT_REMOTE_SOURCE_DISABLED", "请传操作系统路径，不接受 URL 或盘符相对路径。");
    if (/^(?:\\\\[.?]\\|\/\/[.?]\/)/u.test(value) ||
        (drive ? value.slice(2) : value).includes(":"))
        fail("DOCUMENT_PATH_INVALID", "不接受设备路径、命名管道或 ADS。");
    const format = extname(value).slice(1).toLowerCase();
    if (!formats.has(format))
        fail("DOCUMENT_UNSUPPORTED_FORMAT", "支持 PDF、DOCX、PPTX、XLSX、XLS、CSV、PNG/JPEG。");
    return format;
}
export async function resolveSource(ctx, exec, path) {
    const format = validatePath(path);
    const target = await ctx.fs.resolve(path, {
        cwd: exec.agent?.session.header.cwd,
        signal: exec.signal,
    });
    const processPath = ctx.fs.processPath(target);
    validatePath(processPath);
    // Reject a remote execution world instead of reopening the source through Node/Python.
    if (ctx.fs.processPathFromHostPath(process.cwd()) !== process.cwd())
        fail("DOCUMENT_PROVIDER_UNSUPPORTED", "V1 要求 DSH、文件服务和 Python 运行于同一本地主机。");
    const info = await ctx.fs.stat(target, exec.signal);
    if (!info)
        fail("DOCUMENT_NOT_FOUND", "文件不存在。");
    if (info.type !== "file")
        fail("DOCUMENT_NOT_REGULAR_FILE", "仅支持普通文件。");
    await ctx.fs.readByteRange(target, { offset: 0, length: 1 }, exec.signal);
    return { target, info, format };
}
//# sourceMappingURL=security.js.map