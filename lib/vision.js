import { MiB } from "./config.js";
import { DocumentError, aborted, fail } from "./errors.js";
export class DshVision {
    ctx;
    config;
    session;
    unchanged;
    calls = 0;
    constructor(ctx, config, session, unchanged = () => true) {
        this.ctx = ctx;
        this.config = config;
        this.session = session;
        this.unchanged = unchanged;
    }
    async preflight(signal) {
        const deadline = AbortSignal.any([
            signal,
            AbortSignal.timeout(this.config.requestTimeoutMs),
        ]);
        const { llm } = this.services();
        const { provider, model } = this.config;
        if (!provider || !model)
            fail("DOCUMENT_VISION_CONFIG", "请在插件配置中选择 DSH 服务商和视觉模型。");
        const models = await untilAbort(llm.listModels(provider), deadline);
        aborted(signal);
        if (!models.some((m) => m.id === model))
            fail("DOCUMENT_VISION_CONFIG", "已选择的视觉模型当前不在 DSH 模型列表中，请重新选择。");
        const info = await untilAbort(llm.resolveModelInfo(provider, model, deadline), deadline);
        if (!info.inputModalities?.includes("image"))
            fail("DOCUMENT_VISION_CONFIG", "模型未声明图片输入能力，请在 DSH 模型设置中检查。");
    }
    services() {
        const llm = this.ctx.get("llm"), attachments = this.ctx.get("attachments");
        if (!llm || !attachments)
            fail("DOCUMENT_VISION_UNAVAILABLE", "DSH 模型或附件服务未加载；纯文本读取不需要这些服务。");
        return { llm, attachments };
    }
    async analyze(data, mediaType, prompt, signal) {
        aborted(signal);
        if (!this.unchanged())
            fail("DOCUMENT_VISION_CHANGED", "转换期间 DSH 模型配置发生变化，请重新读取文档。");
        if (!data.length ||
            data.length > this.config.maxImageMiB * MiB ||
            !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType))
            fail("DOCUMENT_PROTOCOL_INVALID", "视觉图片格式或大小无效。");
        const { llm, attachments } = this.services();
        const { provider, model } = this.config;
        if (this.calls >= this.config.maxCallsPerDocument)
            return { ok: false, code: "VISION_CALL_LIMIT" };
        let image;
        try {
            image = await untilAbort(attachments.saveImage({
                data,
                mediaType: mediaType,
                name: "document-image",
            }), signal);
        }
        catch {
            aborted(signal);
            return { ok: false, code: "IMAGE_ADMISSION_FAILED" };
        }
        for (let retry = 0; retry <= this.config.maxRetries; retry++) {
            if (this.calls >= this.config.maxCallsPerDocument)
                return { ok: false, code: "VISION_CALL_LIMIT" };
            this.calls++;
            const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
            const callSignal = AbortSignal.any([signal, timeout]);
            try {
                if (!this.unchanged())
                    fail("DOCUMENT_VISION_CHANGED", "转换期间 DSH 模型配置发生变化，请重新读取文档。");
                const prepared = await llm.prepareCall({ provider, model }, callSignal);
                if (!prepared.inputModalities?.includes("image"))
                    fail("DOCUMENT_VISION_CONFIG", "视觉模型已不再支持图片输入。");
                aborted(callSignal);
                const blocks = new Map();
                let chars = 0, finished = false;
                for await (const chunk of prepared.stream({
                    ...prepared.config,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                { type: "image", attachment: image },
                            ],
                        },
                    ],
                    signal: callSignal,
                    ...(this.session ? { sessionId: this.session.id } : {}),
                })) {
                    aborted(callSignal);
                    if (chunk.type === "text-delta") {
                        chars += chunk.text.length;
                        blocks.set(chunk.index, (blocks.get(chunk.index) ?? "") + chunk.text);
                    }
                    else if (chunk.type === "block-end" &&
                        chunk.block.type === "text") {
                        // Accommodate adapters emitting only an assembled block; don't duplicate deltas.
                        chars +=
                            chunk.block.text.length - (blocks.get(chunk.index)?.length ?? 0);
                        blocks.set(chunk.index, chunk.block.text);
                    }
                    else if (chunk.type === "finish") {
                        if (chunk.reason.kind === "error" ||
                            chunk.reason.kind === "aborted") {
                            throw Object.assign(new Error("视觉服务请求失败"), {
                                code: chunk.reason.failure.code,
                            });
                        }
                        if (chunk.reason.kind !== "stop")
                            throw Object.assign(new Error("视觉输出不完整"), {
                                code: "VISION_INCOMPLETE",
                            });
                        finished = true;
                    }
                    if (chars > this.config.maxResponseChars)
                        throw Object.assign(new Error("视觉输出过长"), {
                            code: "VISION_RESPONSE_LIMIT",
                        });
                }
                const text = [...blocks.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([, v]) => v)
                    .join("");
                if (!finished || !text.trim())
                    throw Object.assign(new Error("视觉输出为空"), {
                        code: "VISION_EMPTY",
                    });
                return { ok: true, text };
            }
            catch (error) {
                aborted(signal);
                if (error instanceof DocumentError && !timeout.aborted)
                    throw error;
                const raw = timeout.aborted
                    ? "TIMEOUT"
                    : String(error?.code ?? "VISION_REQUEST_FAILED");
                // Only a bounded machine code crosses the parser boundary, never endpoint bodies or secrets.
                const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(raw)
                    ? raw
                    : "VISION_REQUEST_FAILED";
                const retryable = [
                    "TIMEOUT",
                    "RATE_LIMIT",
                    "NETWORK",
                    "SERVER",
                    "OVERLOADED",
                ].includes(code);
                if (!retryable || retry === this.config.maxRetries)
                    return { ok: false, code };
            }
        }
        return { ok: false, code: "VISION_REQUEST_FAILED" };
    }
}
/** Release the caller promptly even if catalog/storage work lacks cancellation. */
function untilAbort(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        promise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted)
            abort();
    });
}
//# sourceMappingURL=vision.js.map