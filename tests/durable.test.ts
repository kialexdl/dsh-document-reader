import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config.js";
import { Cache } from "../src/cache.js";
import { DurableStore, digest } from "../src/durable.js";
test("durable results enforce quota, expiration, integrity and disabled persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reader-durable-"));
  const config = Config({ progressive: { directory, diskMiB: 1 } }),
    cache = new Cache(config),
    store = new DurableStore(cache);
  try {
    for (let n = 0; n < 8; n++)
      await store.putResult(digest(n), String(n).repeat(190000), config);
    const files = (await readdir(directory)).filter((n) =>
      n.endsWith(".result"),
    );
    let bytes = 0;
    for (const file of files) bytes += (await stat(join(directory, file))).size;
    assert.ok(bytes <= config.progressive.diskMiB * 1024 * 1024);
    assert.equal(await store.getResult(digest(7), config), "7".repeat(190000));
    const last = join(directory, digest(7) + ".result");
    await utimes(last, new Date(0), new Date(0));
    assert.equal(await store.getResult(digest(7), config), undefined);
    await writeFile(
      join(directory, digest(6) + ".result"),
      JSON.stringify({ text: "forged", hash: "wrong" }),
    );
    assert.equal(await store.getResult(digest(6), config), undefined);
    config.progressive.persistent = false;
    await store.putResult(digest(99), "disabled", config);
    assert.equal(await store.getResult(digest(99), config), undefined);
  } finally {
    await cache.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
