import { PluginConfig, snapshotConfig } from "./config.js";
import { DocumentReader, registerTools } from "./tool.js";
import { ReaderModels } from "./model-catalog.js";
export { PluginConfig as Config } from "./config.js";
export const name = "document-reader";
export const inject = ["tools", "fs", "subprocess"];
export function apply(ctx, config) {
    const read = () => snapshotConfig(config);
    const reader = new DocumentReader(ctx, read(), read);
    ctx.plugin(ReaderModels);
    ctx.effect(() => () => reader.dispose());
    ctx.on("session/disposed", (session) => reader.disposeSession(session.id));
    ctx.on("llm/adapters-updated", () => reader.invalidateModels());
    ctx.inject(["settings"], (child) => {
        child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
    });
    ctx.on("loader/volatile-update", () => reader.refreshConfig());
    registerTools(ctx, reader);
}
//# sourceMappingURL=index.js.map