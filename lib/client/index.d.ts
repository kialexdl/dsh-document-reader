/** Native DSH plugin configuration page; no model credentials enter this bundle. */
import type { Context } from "@deepseek-ai/cordis";
import type { PluginConfigViewProps } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
export declare function ReaderSettings({ form, ctx, }: PluginConfigViewProps & {
    ctx: Context;
}): import("react/jsx-runtime").JSX.Element;
export declare const inject: string[];
export declare function apply(ctx: Context): Promise<void>;
