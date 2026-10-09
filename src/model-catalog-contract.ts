/** One shared, strict contract for the plugin's read-only model catalog. */
import { z } from "zod";
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteContribution,
} from "@deepseek-ai/dsh-typert-protocol";

export const modelCatalogSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      models: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          inputModalities: z.array(z.enum(["text", "image"])).optional(),
        }),
      ),
    }),
  ),
  failures: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      message: z.string(),
    }),
  ),
});
export type ReaderModelCatalog = z.infer<typeof modelCatalogSchema>;
export const modelCatalogDescriptor: InvocationDescriptor = {
  id: "dsh-document-reader#documentReaderModels/catalog",
  service: "documentReaderModels",
  namespace: "documentReaderModels",
  method: "catalog",
  invocation: { kind: "direct" },
  parameters: [],
  cancellation: { parameter: "signal" },
  result: {
    mode: "strict",
    typeSymbol: "ReaderModelCatalog",
    create: () => modelCatalogSchema,
  },
};
export const modelCatalogRemote: TypertRemoteContribution = {
  package: "dsh-document-reader",
  descriptors: [modelCatalogDescriptor],
};
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    documentReaderModels: {
      catalog(signal?: AbortSignal): Promise<RemoteResult<ReaderModelCatalog>>;
    };
  }
  interface TypertRemoteMap {
    "documentReaderModels/catalog": (
      signal?: AbortSignal,
    ) => Promise<RemoteResult<ReaderModelCatalog>>;
  }
}
