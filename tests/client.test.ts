import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { Config } from "../src/config.js";
import {
  catalogFixture,
  imageModel,
  clientBundle,
} from "./model-catalog-fixture.js";
import { Context, Service } from "@deepseek-ai/cordis";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
test("client bundle registers in native DSH module loader and row slot", async () => {
  let exported: any, registration: any;
  runInNewContext(await readFile("lib/client.js", "utf8"), {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }: any) => {
          assert.equal(id, "dsh-document-reader");
          exported = factory(require);
        },
      },
    },
  });
  const context = {
    inject: (keys: string[], callback: (ctx: any) => void) => {
      assert.deepEqual([...keys], ["remote.documentReaderModels"]);
      callback(context);
    },
    remote: {
      $mount: async (contribution: any) => {
        assert.equal(
          contribution.descriptors[0].namespace,
          "documentReaderModels",
        );
        return async () => {};
      },
    },
    slots: {
      inject: (_name: string, fn: () => void) => fn(),
      register: (options: any) => {
        registration = options;
        return () => {};
      },
    },
  };
  await exported.apply(context);
  assert.equal(registration.name, "plugins.row.config");
  assert.equal(registration.key, "dsh-document-reader#document-reader");
});
test("compiled host via Loader and compiled client via Cordis show providers/models, save and report failures", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://localhost",
  });
  const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [k, v] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    savedGlobals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, {
      value: v,
      configurable: true,
      writable: true,
    });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let writes: any[] = [];
  const form: any = {
    state: {
      status: "ready",
      value: Config({}),
      revision: 10,
      writable: true,
      mode: "host",
    },
    mutate: async (ops: any[], rev: number) => {
      writes.push({ ops, rev });
      return true;
    },
  };
  const fixture = await catalogFixture(true);
  await fixture.unmountRemote();
  let renderConfig: (props: any) => any;
  // Mount the shipped client through Cordis: unlike the root context, a plugin
  // may only access namespaces declared in its dependency scope.
  class Slots extends Service {
    constructor(ctx: Context) {
      super(ctx, "slots");
    }
    inject(_slot: string, callback: () => any) {
      return callback();
    }
    register(_options: any, render: (props: any) => any) {
      renderConfig = render;
      return () => {};
    }
  }
  await fixture.client.plugin(Slots);
  await fixture.client.plugin((ctx) => {
    new Service(ctx, "locale");
    new Service(ctx, "configForms");
  });
  const clientPlugin = await fixture.client.plugin(
    clientBundle(resolve("lib/client.js")),
  );
  const render = () => root.render(renderConfig({ view: "page", form }));
  try {
    await act(async () => {
      render();
    });
    const selects = () => [...dom.window.document.querySelectorAll("select")];
    assert.deepEqual(
      [...selects()[1]!.options].map((o) => o.value),
      ["", "codeagent"],
    );
    assert.ok(fixture.calls.includes("documentReaderModels/catalog"));
    async function select(index: number, value: string) {
      await act(async () => {
        const e = selects()[index]!;
        e.value = value;
        e.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
    }
    await select(1, "codeagent");
    assert.deepEqual(
      [...selects()[2]!.options].map((o) => o.value),
      ["", imageModel],
    );
    await select(2, imageModel);
    const save = () =>
      [...dom.window.document.querySelectorAll("button")].find(
        (b) => b.textContent === "保存配置",
      )!;
    await act(async () => {
      save().click();
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].rev, 10);
    assert.equal(
      writes[0].ops.find((op: any) => op.path[0] === "vision").value.provider,
      "codeagent",
    );
    assert.equal(
      writes[0].ops.find((op: any) => op.path[0] === "vision").value.model,
      imageModel,
    );
    await select(1, "codeagent");
    await select(2, imageModel);
    form.state = { ...form.state, revision: 11 };
    await act(async () => {
      render();
    });
    assert.equal(save().disabled, true);
    assert.match(dom.window.document.body.textContent!, /配置已被其他窗口修改/);
    await act(async () => {
      [...dom.window.document.querySelectorAll("button")]
        .find((b) => b.textContent === "重新加载配置")!
        .click();
    });
    form.state = {
      ...form.state,
      value: Config({
        vision: { provider: "gone", model: "gone-model", enabled: true },
      }),
    };
    await act(async () => {
      render();
    });
    assert.match(
      dom.window.document.body.textContent!,
      /gone-model（当前不可用）/,
    );
    assert.equal(save().disabled, true);
    await fixture.catalogPlugin.dispose();
    await act(async () => {
      [...dom.window.document.querySelectorAll("button")]
        .find((b) => b.textContent === "刷新模型列表")!
        .click();
    });
    assert.match(
      dom.window.document.body.textContent!,
      /模型能力列表请求失败（gateway\//,
    );
  } finally {
    await act(async () => root.unmount());
    await clientPlugin.dispose();
    assert.equal(fixture.client.get("remote.documentReaderModels"), undefined);
    await fixture.close();
    dom.window.close();
    for (const [k, d] of savedGlobals) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
});
