/** Catalog-only filtering: unknown capability never means image support. */
export interface ModelGroup {
    id: string;
    name: string;
    models: readonly {
        id: string;
        name: string;
        inputModalities?: readonly string[];
    }[];
}
export declare function visualGroups(groups: readonly ModelGroup[]): ModelGroup[];
export declare function selectedAvailable(groups: readonly ModelGroup[], provider: string, model: string): boolean;
