import { Context, Service } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import Registry from "@deepseek-ai/dsh-typert-registry";
import Gateway from "@deepseek-ai/dsh-api-gateway";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ReaderModels } from "../src/model-catalog.js";
import { modelCatalogRemote } from "../src/model-catalog-contract.js";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Include from "@deepseek-ai/cordis-plugin-include";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export function clientBundle(specifier: string): any {
  let exported: any;
  new Function("window", readFileSync(require.resolve(specifier), "utf8"))({
    __ModuleLoader__: {
      load: ({ factory }: any) => {
        exported = factory(require);
      },
    },
  });
  return exported;
}
const ClientGateway = clientBundle("@deepseek-ai/dsh-api-gateway/client");
const ClientRegistry = clientBundle("@deepseek-ai/dsh-typert-registry/client");

export const imageModel = "codeagent/Qwen3.6-27B-CodeAgent-VL";
export const providerConfig = {
  codeagent: {
    displayName: "codeagent",
    apiKeyEnv: "CODEAGENT_API_KEY",
    api: "openai-completions",
    baseURL: "http://127.0.0.1:31943/v1",
    models: [
      { id: imageModel, input: ["text", "image"] },
      {
        id: "codeagent/maas-DeepSeek-V4-Flash-volcengine-codeagent",
        contextWindow: 1000000,
      },
      { id: "codeagent/maas-glm-5.1-zhipu" },
      {
        id: "codeagent/maas-glm-5.2-volcengine-codeagent",
        contextWindow: 1000000,
      },
      { id: "codeagent/maas-qwen3.7-flash" },
      { id: "codeagent/maas-qwen3.7-max" },
      { id: "codeagent/maas-qwen3.7-plus" },
    ],
  },
};

/** Real host/client Gateways and pi-ai; only the physical carrier is in-process. */
export async function catalogFixture(fullPlugin = false) {
  const host = new Context(),
    client = new Context();
  let temporaryRoot: string | undefined;
  const handlers = new Set<{
    claim: (endpoint: string) => boolean;
    run: Function;
  }>();
  const peer = { id: "test-operator", ctx: host, dispose: async () => {} };
  const calls: string[] = [];
  class HostConnection extends Service {
    operator = peer;
    rpc = {
      intercept: (
        _channel: string,
        claim: (s: string) => boolean,
        run: Function,
      ) => {
        const handler = { claim, run };
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    };
    constructor(ctx: Context) {
      super(ctx, "connection");
    }
  }
  class ClientConnection extends Service {
    rpc = {
      open: () => {
        throw Error("No stream required by catalog tests");
      },
      call: async (
        channel: string,
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ) => {
        if (channel !== "/api") throw Error("Wrong shared channel");
        calls.push(endpoint);
        const handler = [...handlers].find((h) => h.claim(endpoint));
        if (!handler) throw Error("No host handler: " + endpoint);
        // Exercise Gateway dispatch/codec, then the same JSON boundary as a browser.
        return JSON.parse(
          JSON.stringify(await handler.run(endpoint, payload, signal, peer)),
        );
      },
    };
    registerGenerationSource() {
      return () => {};
    }
    start() {
      return { stop() {} };
    }
    constructor(ctx: Context) {
      super(ctx, "connection");
    }
  }
  try {
    await host.plugin(Registry);
    await host.plugin(HostConnection);
    await host.plugin(Gateway);
    await host.plugin(LlmRuntime);
    await host.plugin(PiAi, { providers: providerConfig });
    let catalogPlugin;
    if (fullPlugin) {
      temporaryRoot = await mkdtemp(join(tmpdir(), "reader-catalog-loader-"));
      host.baseUrl = pathToFileURL(resolve(".")).href + "/";
      await host.plugin(Loader);
      host.loader.builtins.include = Include;
      const modules = [
        "@deepseek-ai/dsh-system-prompt",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/dsh-fs-local",
        "@deepseek-ai/dsh-subprocess-local",
      ];
      const rows = modules.map(
        (name, i) =>
          `- id: service-${i}\n  name: ${JSON.stringify(import.meta.resolve(name))}`,
      );
      rows.push(
        `- id: document-reader\n  name: ${JSON.stringify(pathToFileURL(resolve("lib/index.js")).href)}`,
      );
      const path = join(temporaryRoot, "cordis.yml");
      await writeFile(path, rows.join("\n") + "\n");
      await host.loader.create({
        name: "cordis:include",
        config: { path: pathToFileURL(path).href },
      });
      await host.loader.await();
      for (const entry of host.loader.entries()) await entry.fiber?.await();
      catalogPlugin = [...host.loader.entries()].find(
        (e) => e.options.id === "document-reader",
      )!.fiber!;
    } else {
      catalogPlugin = await host.plugin(ReaderModels);
    }
    await client.plugin(ClientRegistry);
    await client.plugin(ClientConnection);
    await client.plugin(ClientGateway);
    const unmountRemote = await client.remote.$mount(modelCatalogRemote);
    return {
      host,
      client,
      calls,
      catalogPlugin,
      unmountRemote,
      async close() {
        await client.fiber.dispose();
        await host.fiber.dispose();
        if (temporaryRoot)
          await rm(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client.fiber.dispose();
    await host.fiber.dispose();
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
