import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModelCatalog } from "@deepseek-ai/dsh-api-session-controller";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { catalogFixture, imageModel } from "./model-catalog-fixture.js";
import { visualGroups } from "../src/client/model-options.js";

test("real pi-ai config → host/client Gateways preserves image capability missing in session catalog", async () => {
  const f = await catalogFixture();
  try {
    const legacy = await buildModelCatalog(f.host, {
      provider: "codeagent",
      model: imageModel,
    });
    assert.equal(legacy.groups[0]!.models.length, 7);
    assert.equal("inputModalities" in legacy.groups[0]!.models[0]!, false);
    assert.equal(visualGroups(legacy.groups)[0]!.models.length, 0);
    const result = await f.client.remote.documentReaderModels.catalog();
    assert.equal(result.ok, true);
    if (!result.ok) throw Error(result.error.message);
    assert.deepEqual(result.value.failures, []);
    assert.deepEqual(
      visualGroups(result.value.groups)[0]!.models.map((m) => m.id),
      [imageModel],
    );
    assert.deepEqual(result.value.groups[0]!.models[0]!.inputModalities, [
      "text",
      "image",
    ]);
    assert.deepEqual(f.calls, ["documentReaderModels/catalog"]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /31943|apiKey|CODEAGENT_API_KEY|baseURL/,
    );
    await f.catalogPlugin.dispose();
    assert.equal(
      f.host.typert.local.get("documentReaderModels/catalog"),
      undefined,
    );
    assert.equal(
      (await f.client.remote.documentReaderModels.catalog()).ok,
      false,
    );
  } finally {
    await f.close();
  }
});

test("catalog isolates broken models/providers, excludes unknown capability, and respects cancellation", async () => {
  const f = await catalogFixture();
  class Partial extends LlmAdapter {
    async listModels(provider: string) {
      if (provider === "broken") throw Error("secret token=123");
      return ["good", "unknown", "invalid"].map((id) => ({
        provider,
        id,
        name: id,
      }));
    }
    async resolveModel(provider: string, id: string) {
      if (id === "invalid") throw Error("secret endpoint");
      return {
        provider,
        id,
        name: id,
        ...(id === "good" ? { inputModalities: ["image"] as const } : {}),
      };
    }
    async *stream(): AsyncIterable<never> {
      throw Error("Catalog must not invoke inference");
    }
  }
  try {
    f.host.llm.registerAdapter(["partial", "broken"], new Partial());
    const result = await f.client.remote.documentReaderModels.catalog();
    assert.equal(result.ok, true);
    if (!result.ok) throw Error(result.error.message);
    assert.equal(result.value.failures.length, 2);
    assert.deepEqual(
      visualGroups(result.value.groups)
        .find((g) => g.id === "partial")!
        .models.map((m) => m.id),
      ["good"],
    );
    assert.doesNotMatch(JSON.stringify(result), /secret|token=123/);
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await f.client.remote.documentReaderModels.catalog(controller.signal))
        .ok,
      false,
    );
  } finally {
    await f.close();
  }
});
