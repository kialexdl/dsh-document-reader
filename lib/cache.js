/** Session-local immutable conversions, bounded byte stores and opaque continuation tokens. */
import { mkdtemp, open, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MiB } from "./config.js";
import { aborted, fail } from "./errors.js";
export class ByteStore {
    directory;
    memoryLimit;
    memory;
    handle;
    path;
    chunks = [];
    recordWindow;
    size = 0;
    constructor(directory, memoryLimit) {
        this.directory = directory;
        this.memoryLimit = memoryLimit;
    }
    get memoryBytes() {
        return this.path ? (this.recordWindow?.buffer.length ?? 0) : this.size;
    }
    async append(data) {
        if (!this.handle && this.size + data.length > this.memoryLimit) {
            this.path = join(this.directory, randomUUID());
            this.handle = await open(this.path, "wx+", 0o600);
            for (const chunk of this.chunks)
                await this.handle.write(chunk);
            this.chunks = [];
        }
        if (this.handle)
            await this.handle.write(data);
        else
            this.chunks.push(Buffer.from(data));
        this.size += data.length;
    }
    finish() {
        if (!this.handle) {
            this.memory = Buffer.concat(this.chunks);
            this.chunks = [];
        }
    }
    async slice(start, length) {
        const count = Math.max(0, Math.min(length, this.size - start));
        if (this.memory)
            return this.memory.subarray(start, start + count);
        if (!this.handle)
            return Buffer.alloc(0);
        const buffer = Buffer.alloc(count);
        let offset = 0;
        while (offset < count) {
            const r = await this.handle.read(buffer, offset, count - offset, start + offset);
            if (!r.bytesRead)
                fail("DOCUMENT_CACHE_INVALID", "缓存文件意外结束，请重新读取。");
            offset += r.bytesRead;
        }
        return buffer;
    }
    async record(position) {
        if (position >= this.size)
            return undefined;
        let buffer;
        const window = this.recordWindow;
        const offset = window ? position - window.start : -1;
        if (window &&
            offset >= 0 &&
            offset < window.buffer.length &&
            window.buffer.indexOf(10, offset) >= 0)
            buffer = window.buffer.subarray(offset);
        else {
            buffer = await this.slice(position, 65536);
            this.recordWindow = { start: position, buffer };
        }
        const end = buffer.indexOf(10);
        if (end < 0)
            fail("DOCUMENT_PROTOCOL_INVALID", "位置记录超限。");
        const value = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        return { value: validateSegment(value), next: position + end + 1 };
    }
    async dispose() {
        this.memory = undefined;
        this.recordWindow = undefined;
        this.chunks = [];
        await this.handle?.close();
        this.handle = undefined;
        if (this.path)
            await rm(this.path, { force: true });
    }
}
function validateSegment(value) {
    const s = value;
    if (!s ||
        !Number.isSafeInteger(s.start) ||
        !Number.isSafeInteger(s.end) ||
        s.start < 0 ||
        s.end <= s.start ||
        !Number.isInteger(s.startLine) ||
        !Number.isInteger(s.endLine) ||
        s.startLine < 1 ||
        s.endLine < s.startLine ||
        typeof s.scope !== "string" ||
        !s.location ||
        !["page", "slide", "block", "sheet", "record", "image"].includes(s.location.kind) ||
        ![
            "native",
            "ocr_transcript",
            "generated_description",
            "mixed_or_unknown",
            "metadata",
        ].includes(s.source))
        fail("DOCUMENT_PROTOCOL_INVALID", "无效的位置记录。");
    return s;
}
export class Cache {
    initialConfig;
    secureDirectory;
    readConfig;
    get config() {
        return this.readConfig?.() ?? this.initialConfig;
    }
    entries = new Map();
    cursors = new Map();
    reservations = new Map();
    queue = Promise.resolve();
    rootPromise;
    exception;
    constructor(initialConfig, secureDirectory) {
        this.initialConfig = initialConfig;
        this.secureDirectory = secureDirectory;
    }
    async secure(path) {
        await this.secureDirectory?.(path);
    }
    root() {
        return (this.rootPromise ??= (async () => {
            const directory = await mkdtemp(join(tmpdir(), "dsh-document-reader-"));
            try {
                await this.secureDirectory?.(directory);
                return directory;
            }
            catch (error) {
                await rm(directory, { recursive: true, force: true });
                throw error;
            }
        })());
    }
    async transaction(fn) {
        const result = this.queue.then(fn, fn);
        this.queue = result.catch(() => { });
        return result;
    }
    async reserve(key, bytes, approve) {
        await this.transaction(async () => {
            await this.sweep();
            let used = this.usedExcept(key);
            for (const entry of [...this.entries.values()].sort((a, b) => a.accessed - b.accessed)) {
                if (used + bytes <= this.config.cache.maxTotalMiB * MiB)
                    break;
                if (!entry.pins && entry.key !== key) {
                    await this.remove(entry);
                    used = this.usedExcept(key);
                }
            }
            const normal = this.config.cache.maxTotalMiB * MiB;
            if (used + bytes > normal) {
                if (bytes <= normal)
                    fail("DOCUMENT_BUSY", "缓存正在使用，当前配额不足，请稍后重试。");
                if (this.exception && this.exception !== key)
                    fail("DOCUMENT_BUSY", "已有超额转换正在保留，请稍后重试。");
                if (this.exception !== key ||
                    bytes >
                        (this.reservations.get(key) ?? this.entries.get(key)?.size ?? 0))
                    await approve(bytes);
                this.exception = key;
            }
            this.reservations.set(key, bytes);
        });
    }
    usedExcept(key) {
        return ([...this.entries.values()]
            .filter((e) => e.key !== key)
            .reduce((n, e) => n + e.size, 0) +
            [...this.reservations]
                .filter(([k]) => k !== key)
                .reduce((n, [, v]) => n + v, 0));
    }
    releaseReservation(key) {
        this.reservations.delete(key);
        if (!this.entries.has(key) && this.exception === key)
            this.exception = undefined;
    }
    memoryAvailable() {
        return Math.max(0, this.config.cache.memoryTotalMiB * MiB * 0.75 -
            [...this.entries.values()].reduce((n, e) => n + e.memory, 0));
    }
    async publish(entry) {
        await this.transaction(async () => {
            const old = this.entries.get(entry.key);
            if (old && old !== entry) {
                if (old.pins)
                    fail("DOCUMENT_BUSY", "原缓存仍在使用。");
                await this.remove(old);
            }
            this.entries.set(entry.key, entry);
            this.reservations.delete(entry.key);
        });
    }
    async acquire(key, expected) {
        const entry = this.entries.get(key);
        if (entry && this.isExpired(entry)) {
            entry.expired = true;
            if (!entry.pins)
                await this.remove(entry);
        }
        const current = this.entries.get(key);
        if (expected &&
            (!current || current.expired || current.revision !== expected))
            fail("DOCUMENT_REVISION_EXPIRED", "转换结果已失效，请重新搜索或从第 1 行开始读取。");
        if (!current || current.expired)
            return undefined;
        current.accessed = Date.now();
        current.pins++;
        return current;
    }
    async invalidate(key) {
        const entry = this.entries.get(key);
        if (entry) {
            entry.expired = true;
            if (!entry.pins)
                await this.remove(entry);
        }
    }
    async unpin(entry) {
        entry.pins--;
        if (!entry.pins && entry.expired)
            await this.remove(entry);
    }
    cursor(entry, kind, state) {
        const bytes = Buffer.byteLength(JSON.stringify(state)) * 2 + 512;
        const budget = Math.min((this.config.cache.memoryTotalMiB * MiB) / 4, (this.config.cache.maxTotalMiB * MiB) / 4);
        if (bytes > budget)
            fail("DOCUMENT_LIMIT_EXCEEDED", "续查状态超过缓存内存预算，请缩小关键词数量。");
        const used = () => [...this.cursors.values()].reduce((n, c) => n + c.bytes, 0);
        while (this.cursors.size &&
            (this.cursors.size >= this.config.cache.maxCursors ||
                used() + bytes > budget))
            this.cursors.delete(this.cursors.keys().next().value);
        const id = randomUUID();
        this.cursors.set(id, {
            bytes,
            session: entry.session,
            key: entry.key,
            revision: entry.revision,
            kind,
            state: structuredClone(state),
            created: Date.now(),
        });
        return id;
    }
    getCursor(id, session, key, kind) {
        const value = this.cursors.get(id);
        if (!value ||
            value.session !== session ||
            value.key !== key ||
            value.kind !== kind ||
            Date.now() - value.created > this.config.cache.ttlMinutes * 60000)
            fail("DOCUMENT_CURSOR_INVALID", "续读位置已失效，请重新发起读取或搜索。");
        return value;
    }
    discardCursor(id) {
        this.cursors.delete(id);
    }
    isExpired(e) {
        return (e.expired ||
            Date.now() - e.accessed >= this.config.cache.ttlMinutes * 60000 ||
            (e.meta.partial &&
                Date.now() - e.created >= this.config.cache.partialTtlMinutes * 60000));
    }
    async sweep(session) {
        for (const entry of [...this.entries.values()])
            if (session ? entry.session === session : this.isExpired(entry)) {
                entry.expired = true;
                if (!entry.pins)
                    await this.remove(entry);
            }
        for (const [id, c] of this.cursors)
            if (session
                ? c.session === session
                : !this.entries.has(c.key) ||
                    Date.now() - c.created > this.config.cache.ttlMinutes * 60000)
                this.cursors.delete(id);
    }
    async remove(e) {
        if (this.entries.get(e.key) === e)
            this.entries.delete(e.key);
        for (const [id, c] of this.cursors)
            if (c.revision === e.revision)
                this.cursors.delete(id);
        await Promise.all([e.body.dispose(), e.mapping.dispose()]);
        if (this.exception === e.key)
            this.exception = undefined;
    }
    async dispose() {
        await this.queue;
        for (const e of [...this.entries.values()])
            await this.remove(e);
        this.cursors.clear();
        if (this.rootPromise)
            await rm(await this.rootPromise, { recursive: true, force: true });
    }
}
/** Build a sparse index and verify complete UTF-8 plus mapping continuity before publication. */
export async function validateEntry(entry, signal, indexBudget = 16 * MiB) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const index = [{ line: 1, byte: 0 }];
    let line = 1;
    for (let pos = 0; pos < entry.body.size; pos += 65536) {
        aborted(signal);
        const b = await entry.body.slice(pos, 65536);
        decoder.decode(b, { stream: true });
        for (let i = 0; i < b.length; i++)
            if (b[i] === 10) {
                line++;
                if ((line - 1) % 1024 === 0) {
                    if ((index.length + 1) * 64 > indexBudget)
                        fail("DOCUMENT_LIMIT_EXCEEDED", "行索引超过缓存内存预算，请调整 cache.memoryTotalMiB。");
                    index.push({ line, byte: pos + i + 1 });
                }
            }
    }
    decoder.decode();
    if ((entry.body.size ? line : 0) !== entry.meta.totalLines)
        fail("DOCUMENT_PROTOCOL_INVALID", "正文行数不一致。");
    let pos = 0, previous = 0, count = 0;
    while (pos < entry.mapping.size) {
        const record = (await entry.mapping.record(pos));
        if (record.value.start !== previous ||
            record.value.end > entry.body.size ||
            record.value.endLine > entry.meta.totalLines)
            fail("DOCUMENT_PROTOCOL_INVALID", "位置范围不连续或越界。");
        previous = record.value.end;
        pos = record.next;
        count++;
    }
    if (previous !== entry.body.size || count !== entry.meta.records)
        fail("DOCUMENT_PROTOCOL_INVALID", "位置记录与正文不一致。");
    entry.index = index;
    entry.memory =
        entry.body.memoryBytes + entry.mapping.memoryBytes + index.length * 64;
    entry.size += index.length * 64;
}
export async function byteAtLine(entry, line) {
    const anchor = entry.index[Math.floor((line - 1) / 1024)] ?? entry.index.at(-1);
    let current = anchor.line, pos = anchor.byte;
    while (current < line && pos < entry.body.size) {
        const b = await entry.body.slice(pos, 65536);
        for (let i = 0; i < b.length; i++)
            if (b[i] === 10 && ++current === line)
                return pos + i + 1;
        pos += b.length;
    }
    return pos;
}
export async function lineAtByte(entry, position) {
    let anchor = entry.index[0];
    for (const a of entry.index) {
        if (a.byte > position)
            break;
        anchor = a;
    }
    let line = anchor.line;
    for (let pos = anchor.byte; pos < position; pos += 65536)
        for (const b of await entry.body.slice(pos, Math.min(65536, position - pos)))
            if (b === 10)
                line++;
    return line;
}
//# sourceMappingURL=cache.js.map