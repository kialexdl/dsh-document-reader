/** One shared, strict contract for the plugin's read-only model catalog. */
import { z } from "zod";
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
export declare const modelCatalogSchema: z.ZodObject<{
    groups: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        models: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            inputModalities: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                image: "image";
                text: "text";
            }>>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    failures: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ReaderModelCatalog = z.infer<typeof modelCatalogSchema>;
export declare const modelCatalogDescriptor: InvocationDescriptor;
export declare const modelCatalogRemote: TypertRemoteContribution;
declare module "@deepseek-ai/dsh-typert-protocol" {
    interface TypertRemoteNamespaceMap {
        documentReaderModels: {
            catalog(signal?: AbortSignal): Promise<RemoteResult<ReaderModelCatalog>>;
        };
    }
    interface TypertRemoteMap {
        "documentReaderModels/catalog": (signal?: AbortSignal) => Promise<RemoteResult<ReaderModelCatalog>>;
    }
}
