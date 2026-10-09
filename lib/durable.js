/** Local, quota-bounded checkpoints. Never stores source paths, credentials or failures. */
import { mkdir, mkdtemp, open, readFile, writeFile, rename, rm, readdir, stat, lstat, chmod, copyFile, utimes, } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { MiB } from "./config.js";
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeName = /^[a-f0-9]{64}(?:\.image|\.png)?$|^(?:body|mapping|meta|images)\.json$|^(?:body|mapping)\.bin$/;
async function hashFile(path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path))
        hash.update(chunk);
    return hash.digest("hex");
}
export class DurableStore {
    cache;
    roots = new Map();
    queue = Promise.resolve();
    constructor(cache) {
        this.cache = cache;
    }
    async root(config) {
        const directory = config.progressive.directory ||
            join(process.platform === "win32"
                ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
                : process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "dsh-document-reader", "v3");
        let root = this.roots.get(directory);
        if (!root) {
            root = (async () => {
                await mkdir(directory, { recursive: true, mode: 0o700 });
                if ((await lstat(directory)).isSymbolicLink())
                    throw Error("cache directory is a link");
                await chmod(directory, 0o700);
                await this.cache.secure(directory);
                return directory;
            })();
            this.roots.set(directory, root);
        }
        return root;
    }
    async serial(fn) {
        const result = this.queue.then(fn, fn);
        this.queue = result.catch(() => { });
        return result;
    }
    async loadDocument(key, destination, config) {
        if (!config.progressive.persistent)
            return false;
        return this.serial(async () => {
            try {
                const directory = join(await this.root(config), key + ".doc");
                const info = await lstat(directory);
                if (!info.isDirectory() ||
                    Date.now() - info.mtimeMs >
                        config.progressive.retentionDays * 86400000)
                    return false;
                const raw = await readFile(join(directory, "checks.json"), "utf8");
                if (raw.length > config.conversion.maxMapRecords * 256)
                    return false;
                const checks = JSON.parse(raw);
                let total = 0;
                for (const [name, hash] of Object.entries(checks)) {
                    if (!safeName.test(name) || !/^[a-f0-9]{64}$/.test(hash))
                        return false;
                    const path = join(directory, name), st = await lstat(path);
                    total += st.size;
                    if (!st.isFile() ||
                        total > config.progressive.diskMiB * MiB ||
                        (await hashFile(path)) !== hash)
                        return false;
                }
                if (!["body.bin", "mapping.bin", "meta.json", "images.json"].every((n) => n in checks))
                    return false;
                for (const name of Object.keys(checks))
                    await copyFile(join(directory, name), join(destination, name));
                await utimes(directory, new Date(), new Date());
                return true;
            }
            catch {
                return false;
            }
        });
    }
    async saveDocument(key, entry, assets, config) {
        if (!config.progressive.persistent)
            return;
        await this.serial(async () => {
            const root = await this.root(config), stage = await mkdtemp(join(root, ".stage-"));
            try {
                for (const [name, store] of [
                    ["body.bin", entry.body],
                    ["mapping.bin", entry.mapping],
                ]) {
                    const handle = await open(join(stage, name), "wx", 0o600);
                    try {
                        for (let p = 0; p < store.size; p += 65536)
                            await handle.write(await store.slice(p, 65536));
                    }
                    finally {
                        await handle.close();
                    }
                }
                await writeFile(join(stage, "meta.json"), JSON.stringify(entry.meta), {
                    mode: 0o600,
                });
                for (const name of await readdir(assets))
                    if (name === "images.json" || /^[a-f0-9]{64}\.image$/.test(name))
                        await copyFile(join(assets, name), join(stage, name));
                const checks = {};
                let total = 0;
                for (const name of await readdir(stage)) {
                    total += (await stat(join(stage, name))).size;
                    checks[name] = await hashFile(join(stage, name));
                }
                if (total > config.progressive.diskMiB * MiB)
                    throw Error("persistent quota");
                await writeFile(join(stage, "checks.json"), JSON.stringify(checks), {
                    mode: 0o600,
                });
                const dest = join(root, key + ".doc");
                // Existing snapshots may be damaged; replace under our serialized writer.
                await rm(dest, { recursive: true, force: true });
                await rename(stage, dest);
                await this.sweep(root, config);
            }
            finally {
                await rm(stage, { recursive: true, force: true });
            }
        });
    }
    async getResult(key, config) {
        if (!config.progressive.persistent)
            return;
        return this.serial(async () => {
            try {
                const path = join(await this.root(config), key + ".result"), info = await lstat(path);
                if (!info.isFile() ||
                    info.size > config.vision.maxResponseChars * 6 + 1000 ||
                    Date.now() - info.mtimeMs >
                        config.progressive.retentionDays * 86400000)
                    return;
                const obj = JSON.parse(await readFile(path, "utf8"));
                if (typeof obj.text !== "string" ||
                    obj.text.length > config.vision.maxResponseChars ||
                    digest(obj.text) !== obj.hash)
                    return;
                await utimes(path, new Date(), new Date());
                return obj.text;
            }
            catch {
                return;
            }
        });
    }
    async putResult(key, text, config) {
        if (!config.progressive.persistent)
            return;
        await this.serial(async () => {
            const root = await this.root(config), temp = join(root, ".stage-" + randomUUID());
            try {
                const bytes = JSON.stringify({ text, hash: digest(text) });
                if (Buffer.byteLength(bytes) > config.progressive.diskMiB * MiB)
                    throw Error("persistent quota");
                await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
                await rename(temp, join(root, key + ".result"));
                await this.sweep(root, config);
            }
            finally {
                await rm(temp, { force: true });
            }
        });
    }
    async sweep(root, config) {
        const items = [];
        for (const name of await readdir(root)) {
            if (name.startsWith(".stage-")) {
                const path = join(root, name), info = await lstat(path);
                // All legitimate conversions are bounded; reclaim only old owned staging names.
                if (Date.now() - info.mtimeMs > 86400000)
                    await rm(path, { recursive: true, force: true });
                continue;
            }
            if (!/^[a-f0-9]{64}\.(doc|result)$/.test(name))
                continue;
            const path = join(root, name), info = await lstat(path);
            if (info.isSymbolicLink())
                continue;
            let size = info.size;
            if (info.isDirectory())
                for (const n of await readdir(path))
                    size += (await lstat(join(path, n))).size;
            items.push({ path, size, time: info.mtimeMs });
        }
        let total = items.reduce((n, x) => n + x.size, 0);
        for (const item of items.sort((a, b) => a.time - b.time)) {
            if (Date.now() - item.time < config.progressive.retentionDays * 86400000 &&
                total <= config.progressive.diskMiB * MiB)
                continue;
            await rm(item.path, { recursive: true, force: true });
            total -= item.size;
        }
    }
}
//# sourceMappingURL=durable.js.map