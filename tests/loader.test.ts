import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Include from "@deepseek-ai/cordis-plugin-include";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { FsError } from "@deepseek-ai/dsh-fs";

const python = process.env.DOCUMENT_READER_TEST_PYTHON;
test("real Loader registers and unloads both tools without Python installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-startup-"));
  const ctx = new Context();
  try {
    ctx.baseUrl = pathToFileURL(resolve(".")).href + "/";
    await ctx.plugin(Loader);
    ctx.loader.builtins.include = Include;
    const rows = [
      "@deepseek-ai/dsh-system-prompt",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/dsh-fs-local",
      "@deepseek-ai/dsh-subprocess-local",
    ].map(
      (name, i) =>
        `- id: service-${i}\n  name: ${JSON.stringify(import.meta.resolve(name))}`,
    );
    rows.push(
      `- id: document-reader\n  name: ${JSON.stringify(pathToFileURL(resolve("lib/index.js")).href)}\n  config:\n    python:\n      executable: /nonexistent/document-reader-python`,
    );
    const path = join(root, "cordis.yml");
    await writeFile(path, rows.join("\n") + "\n");
    await ctx.loader.create({
      name: "cordis:include",
      config: { path: pathToFileURL(path).href },
    });
    await ctx.loader.await();
    for (const e of ctx.loader.entries()) await e.fiber?.await();
    assert.ok(ctx.tools.get("read_document"));
    assert.ok(ctx.tools.get("search_document"));
    const plugin = [...ctx.loader.entries()].find(
      (e) => e.options.id === "document-reader",
    )!;
    await plugin.fiber!.dispose();
    assert.equal(ctx.tools.get("read_document"), undefined);
    assert.equal(ctx.tools.get("search_document"), undefined);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
const text = (r: { content: readonly { type: string; text?: string }[] }) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
test(
  "real Loader composition: read/search, shared cache, denied cache hit, revision, unload",
  { skip: !python, timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-loader-"));
    const ctx = new Context();
    try {
      ctx.baseUrl = pathToFileURL(resolve(".")).href + "/";
      await ctx.plugin(Loader);
      ctx.loader.builtins.include = Include;
      const names = [
        "@deepseek-ai/dsh-system-prompt",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/dsh-fs-local",
        "@deepseek-ai/dsh-subprocess-local",
        "@deepseek-ai/dsh-agent",
        "@deepseek-ai/dsh-user-approval",
      ];
      const rows = names.map(
        (name, i) =>
          `- id: service-${i}\n  name: ${JSON.stringify(import.meta.resolve(name))}`,
      );
      rows.push(
        `- id: document-reader\n  name: ${JSON.stringify(pathToFileURL(resolve("lib/index.js")).href)}\n  config:\n    python:\n      executable: ${JSON.stringify(python)}\n    read:\n      maxLines: 2\n    cache:\n      memoryEntryMiB: 1\n      memoryTotalMiB: 1\n      maxTotalMiB: 1`,
      );
      const configPath = join(root, "cordis.yml");
      await writeFile(configPath, rows.join("\n") + "\n");
      await ctx.loader.create({
        name: "cordis:include",
        config: { path: pathToFileURL(configPath).href },
      });
      await ctx.loader.await();
      for (const e of ctx.loader.entries()) await e.fiber?.await();
      assert.ok(
        ctx.tools.get("read_document"),
        "plugin must be registered through Loader",
      );
      assert.ok(ctx.tools.get("search_document"));
      const scope = ctx.plugin(() => {});
      const session = Session.create(SessionId("reader-integration"));
      // The external caller is deterministic; all filesystem, subprocess and tool services are real.
      const owner = {
        id: session.id,
        options: {},
        session,
        ctx: scope.ctx,
        status: "idle",
        inbox: {},
        cancel() {},
        followup() {},
        steer() {},
        inject() {},
        send() {},
        runMaintenance: async (task: (s: AbortSignal) => Promise<void>) =>
          task(new AbortController().signal),
        whenIdle: async () => {},
      } as unknown as Agent;
      await ctx.agents.register(owner);
      const path = join(root, "中文 文档.csv");
      await writeFile(path, "name,value\nservice,OpenStack\nneedle,C++\n");
      let conversions = 0;
      const spawn = ctx.subprocess.spawn.bind(ctx.subprocess);
      ctx.subprocess.spawn = (spec) => {
        if (
          spec.argv.some((x) => x.endsWith("markitdown_bridge.py")) &&
          !spec.argv.includes("--doctor")
        )
          conversions++;
        return spawn(spec);
      };
      let serial = 0;
      const call = async (
        name: string,
        args: unknown,
        signal = new AbortController().signal,
      ) =>
        ctx.tools.execute({
          name,
          arguments: args,
          callId: ToolCallId("reader-" + serial++),
          agent: owner,
          signal,
        });
      const r = await call("search_document", {
        file_path: path,
        keywords: ["openstack"],
      });
      assert.equal(r.isError, false, text(r));
      const found = JSON.parse(text(r));
      assert.equal(found.results.length, 1);
      const read = await call(
        "read_document",
        found.results[0].snippets[0].read_args,
      );
      assert.equal(read.isError, false, text(read));
      assert.equal(conversions, 1);
      const revision = JSON.parse(text(read)).document_revision;
      assert.equal(revision, found.document_revision);
      const readByteRange = ctx.fs.readByteRange.bind(ctx.fs);
      ctx.fs.readByteRange = async () => {
        throw new FsError("denied by provider", "FS_PERMISSION_DENIED");
      };
      const denied = await call("read_document", { file_path: path });
      assert.equal(denied.isError, true);
      assert.match(text(denied), /denied/);
      ctx.fs.readByteRange = readByteRange;
      await writeFile(path, "name,value\nservice,Changed\n");
      const stale = await call("read_document", {
        file_path: path,
        expected_revision: revision,
      });
      assert.equal(stale.isError, true);
      assert.match(text(stale), /DOCUMENT_REVISION_EXPIRED/);
      const extra = await call("search_document", {
        file_path: path,
        keywords: ["Changed"],
        match: "regex",
      });
      assert.equal(extra.isError, true);
      assert.match(text(extra), /不支持的参数/);
      // Two callers share conversion; cancelling one caller must not kill the other's work.
      const concurrent = join(root, "concurrent.csv");
      await writeFile(concurrent, "name,value\nservice,Concurrent\n");
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
          release = r;
        }),
        started = new Promise<void>((r) => {
          entered = r;
        });
      ctx.fs.readByteRange = async (target, range, signal) => {
        if (range.length > 1) {
          entered();
          await gate;
        }
        return readByteRange(target, range, signal);
      };
      const controller = new AbortController(),
        before = conversions;
      const first = call(
        "read_document",
        { file_path: concurrent },
        controller.signal,
      );
      await started;
      const second = call("search_document", {
        file_path: concurrent,
        keywords: ["Concurrent"],
      });
      await new Promise((r) => setTimeout(r, 25));
      controller.abort();
      release();
      const [cancelled, survived] = await Promise.all([first, second]);
      assert.equal(cancelled.isError, true);
      assert.equal(survived.isError, false, text(survived));
      assert.equal(conversions, before + 1);
      ctx.fs.readByteRange = readByteRange;
      // Native approval audits both grant and rejection; cache reuse never asks again.
      session.append("turn/start", { turn: 1 });
      let approvals = 0,
        allow = true;
      ctx.on("approval/request", async () => {
        approvals++;
        return allow ? "allowed-once" : "rejected";
      });
      const large = join(root, "large.csv");
      await writeFile(large, "header\n" + "large".repeat(230000));
      const largeBefore = conversions;
      const granted = await call("read_document", { file_path: large });
      assert.equal(granted.isError, false, text(granted));
      assert.equal(conversions, largeBefore + 1);
      const approved = approvals;
      assert.ok(approved >= 1);
      const again = await call(
        "read_document",
        JSON.parse(text(granted)).next_read_args,
      );
      assert.equal(again.isError, false, text(again));
      assert.equal(approvals, approved);
      assert.equal(conversions, largeBefore + 1);
      assert.ok(
        session.snapshotEvents().some((e) => e.type === "approval/decided"),
      );
      ctx.emit("session/disposed", session);
      await new Promise((r) => setTimeout(r, 30));
      allow = false;
      const rejected = await call("read_document", { file_path: large });
      assert.equal(rejected.isError, true);
      assert.match(text(rejected), /DOCUMENT_LIMIT_EXCEEDED/);
      const wordPath = join(root, "schema.docx");
      execFileSync(python!, [
        "-c",
        "from docx import Document;from PIL import Image;import io,sys;d=Document();d.add_paragraph('needle');b=io.BytesIO();Image.new('RGB',(20,20),'red').save(b,format='PNG');b.seek(0);d.add_picture(b);d.save(sys.argv[1])",
        wordPath,
      ]);
      const word = await call("search_document", {
        file_path: wordPath,
        keywords: ["needle"],
      });
      assert.equal(word.isError, false, text(word));
      const wordValue = JSON.parse(text(word));
      assert.equal(wordValue.image_progress.skipped, 1);
      const wordRead = await call(
        "read_document",
        wordValue.results[0].snippets[0].read_args,
      );
      assert.equal(wordRead.isError, false, text(wordRead));
      const plugin = [...ctx.loader.entries()].find(
        (e) => e.options.id === "document-reader",
      )!;
      await plugin.fiber!.dispose();
      assert.equal(ctx.tools.get("read_document"), undefined);
      assert.equal(ctx.tools.get("search_document"), undefined);
    } finally {
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
