/** Model capabilities come from the live registry, not the lossy session catalog. */
import { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { type ReaderModelCatalog } from "./model-catalog-contract.js";
declare module "@deepseek-ai/cordis" {
    interface Context {
        documentReaderModels: ReaderModels;
    }
}
export declare class ReaderModels extends TypertRemoteService {
    static inject: string[];
    constructor(ctx: Context);
    catalog(signal?: AbortSignal): Promise<ReaderModelCatalog>;
}
