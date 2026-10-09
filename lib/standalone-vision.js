import { aborted } from "./errors.js";
export async function standaloneVision(data, prompt, config, signal, admit = () => true) {
    for (let attempt = 0; attempt <= config.vision.maxRetries; attempt++) {
        aborted(signal);
        if (!admit())
            return { ok: false, code: "VISION_CALL_LIMIT" };
        const deadline = AbortSignal.any([
            signal,
            AbortSignal.timeout(config.vision.requestTimeoutMs),
        ]);
        try {
            const response = await fetch(config.vision.baseURL.replace(/\/$/, "") + "/chat/completions", {
                method: "POST",
                redirect: "error",
                signal: deadline,
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer " + process.env[config.vision.apiKeyEnv],
                },
                body: JSON.stringify({
                    model: config.vision.model,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: "data:image/png;base64," + data.toString("base64"),
                                    },
                                },
                            ],
                        },
                    ],
                }),
            });
            if (!response.ok) {
                await response.body?.cancel();
                if ((response.status === 429 || response.status >= 500) &&
                    attempt < config.vision.maxRetries)
                    continue;
                return { ok: false, code: "VISION_HTTP_" + response.status };
            }
            let size = 0;
            const chunks = [];
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > config.vision.maxResponseChars * 6 + 65536)
                    return { ok: false, code: "VISION_RESPONSE_LIMIT" };
                chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const choice = body.choices?.[0], text = choice?.message?.content;
            if (choice?.finish_reason !== "stop" ||
                typeof text !== "string" ||
                text.length > config.vision.maxResponseChars)
                return { ok: false, code: "VISION_INCOMPLETE" };
            return { ok: true, text };
        }
        catch {
            aborted(signal);
            if (attempt === config.vision.maxRetries)
                return { ok: false, code: deadline.aborted ? "TIMEOUT" : "NETWORK" };
        }
    }
    return { ok: false, code: "VISION_REQUEST_FAILED" };
}
//# sourceMappingURL=standalone-vision.js.map