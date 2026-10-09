import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Include from "@deepseek-ai/cordis-plugin-include";
import ConfigEditor from "@deepseek-ai/dsh-config-editor";
import Settings from "@deepseek-ai/dsh-settings";
import { mountRootInclude } from "@deepseek-ai/dsh-app-boot";
import { snapshotConfig, type LiveConfig } from "../src/config.js";
test("real settings save persists, live references update without remount, stale write rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-settings-")),
    ctx = new Context();
  try {
    const profile = {
      name: "reader-test",
      dir: root,
      patchPath: join(root, "cordis.patch.yml"),
      installAnchor: resolve("package.json"),
      cwd: root,
      home: join(root, "home"),
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    };
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "reader-test",
        version: "1.0.0",
        private: true,
        dsh: { profile: { bundles: [] } },
      }),
    );
    await writeFile(join(root, "cordis.yml"), "[]\n");
    const names = [
      "@deepseek-ai/dsh-system-prompt",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/dsh-fs-local",
      "@deepseek-ai/dsh-subprocess-local",
    ];
    const rows = names.map((name, i) => ({
      id: "svc" + i,
      name: import.meta.resolve(name),
    }));
    rows.push({
      id: "document-reader",
      name: pathToFileURL(resolve("lib/index.js")).href,
    });
    const patches = [{ insert: rows }];
    await writeFile(profile.patchPath, JSON.stringify(patches));
    ctx.baseUrl = pathToFileURL(resolve(".")).href + "/";
    await ctx.plugin(Loader);
    ctx.loader.builtins.include = Include;
    ctx.reflect.provide("profileContext", profile);
    await ctx.plugin(ConfigEditor);
    await ctx.plugin(Settings);
    await mountRootInclude(ctx, join(root, "cordis.yml"), patches);
    await ctx.loader.await();
    for (const e of ctx.loader.entries()) await e.fiber?.await();
    const entry = [...ctx.loader.entries()].find(
      (e) => e.options.id === "document-reader",
    )!;
    assert.ok(entry?.fiber);
    const fiber = entry.fiber;
    const before = ctx.settings
      .describe()
      .find((d) => d.ns === "document-reader")!;
    assert.ok(before);
    assert.equal(before.autoGenerate, false);
    await ctx.settings.mutate(
      "document-reader",
      [
        { op: "set", path: ["vision", "source"], value: "dsh" },
        { op: "set", path: ["vision", "provider"], value: "company" },
        { op: "set", path: ["vision", "model"], value: "vision-a" },
        { op: "set", path: ["vision", "enabled"], value: true },
      ],
      before.revision,
    );
    assert.equal(
      entry.fiber,
      fiber,
      "volatile edits must not interrupt running tools",
    );
    await ctx.loader.await();
    const after = ctx.settings
      .describe()
      .find((d) => d.ns === "document-reader")!;

    assert.equal(
      (after.value as { vision: { model: string } }).vision.model,
      "vision-a",
    );
    assert.equal(
      snapshotConfig(fiber!.config as LiveConfig).vision.model,
      "vision-a",
    );
    assert.ok((await readFile(profile.patchPath, "utf8")).includes("vision-a"));
    await assert.rejects(
      ctx.settings.mutate(
        "document-reader",
        [{ op: "set", path: ["vision", "model"], value: "vision-b" }],
        before.revision,
      ),
      /revision|changed|conflict/i,
    );
    const stable = await readFile(profile.patchPath, "utf8");
    await assert.rejects(
      ctx.settings.mutate(
        "document-reader",
        [{ op: "set", path: ["vision", "maxRetries"], value: -1 }],
        after.revision,
      ),
    );
    assert.equal(await readFile(profile.patchPath, "utf8"), stable);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
