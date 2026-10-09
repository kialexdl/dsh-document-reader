/** Model capabilities come from the live registry, not the lossy session catalog. */
import { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-typert-registry";
import {
  modelCatalogDescriptor,
  type ReaderModelCatalog,
} from "./model-catalog-contract.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    documentReaderModels: ReaderModels;
  }
}

export class ReaderModels extends TypertRemoteService {
  static inject = ["llm", "typert"];
  constructor(ctx: Context) {
    super(ctx, "documentReaderModels");
    // Both sides use the same descriptor/schema, including inputModalities.
    ctx.typert.register({
      package: "dsh-document-reader",
      face: "host",
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [modelCatalogDescriptor],
    });
  }

  async catalog(signal?: AbortSignal): Promise<ReaderModelCatalog> {
    const deadline = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(10000),
    ]);
    const llm = this.ctx.llm;
    // Whitelist public metadata. Never serialize profiles, endpoints or credentials.
    const results = await Promise.all(
      llm.listProviders().map(async (provider) => {
        const group: ReaderModelCatalog["groups"][number] = {
          id: provider.id,
          name: provider.name,
          models: [],
        };
        const failures: ReaderModelCatalog["failures"] = [];
        try {
          const models = await bounded(llm.listModels(provider.id), deadline);
          // Isolate one invalid model instead of hiding the provider's valid models.
          const resolved = await Promise.all(
            models.map(async (model) => {
              try {
                const info = await bounded(
                  llm.resolveModelInfo(provider.id, model.id, deadline),
                  deadline,
                );
                return {
                  id: model.id,
                  name: model.name,
                  ...(info.inputModalities === undefined
                    ? {}
                    : { inputModalities: [...info.inputModalities] }),
                };
              } catch {
                failures.push({
                  id: provider.id,
                  name: provider.name,
                  message: `模型 ${model.id} 的输入能力读取失败。`,
                });
                return undefined;
              }
            }),
          );
          group.models = resolved.filter((m) => m !== undefined);
        } catch {
          failures.push({
            id: provider.id,
            name: provider.name,
            message: "服务商模型列表读取失败或超时。",
          });
        }
        return { group, failures };
      }),
    );
    signal?.throwIfAborted();
    return {
      groups: results.map((r) => r.group),
      failures: results.flatMap((r) => r.failures),
    };
  }
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
