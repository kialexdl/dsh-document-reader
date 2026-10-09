export function visualGroups(groups) {
    return groups.map((group) => ({
        ...group,
        models: group.models.filter((m) => m.inputModalities?.includes("image")),
    }));
}
export function selectedAvailable(groups, provider, model) {
    return !!groups
        .find((p) => p.id === provider)
        ?.models.some((m) => m.id === model && m.inputModalities?.includes("image"));
}
//# sourceMappingURL=model-options.js.map