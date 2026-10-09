/** One shared, strict contract for the plugin's read-only model catalog. */
import { z } from "zod";
export const modelCatalogSchema = z.object({
    groups: z.array(z.object({
        id: z.string(),
        name: z.string(),
        models: z.array(z.object({
            id: z.string(),
            name: z.string(),
            inputModalities: z.array(z.enum(["text", "image"])).optional(),
        })),
    })),
    failures: z.array(z.object({
        id: z.string(),
        name: z.string(),
        message: z.string(),
    })),
});
export const modelCatalogDescriptor = {
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
export const modelCatalogRemote = {
    package: "dsh-document-reader",
    descriptors: [modelCatalogDescriptor],
};
//# sourceMappingURL=model-catalog-contract.js.map