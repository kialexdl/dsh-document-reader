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
export function visualGroups(groups: readonly ModelGroup[]): ModelGroup[] {
  return groups.map((group) => ({
    ...group,
    models: group.models.filter((m) => m.inputModalities?.includes("image")),
  }));
}
export function selectedAvailable(
  groups: readonly ModelGroup[],
  provider: string,
  model: string,
): boolean {
  return !!groups
    .find((p) => p.id === provider)
    ?.models.some(
      (m) => m.id === model && m.inputModalities?.includes("image"),
    );
}
