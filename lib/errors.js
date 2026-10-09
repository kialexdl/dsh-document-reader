/** Expected failures carry a stable code and a credential-free explanation. */
export class DocumentError extends Error {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
        this.name = "DocumentError";
    }
}
export function fail(code, message) {
    throw new DocumentError(code, message);
}
export function aborted(signal) {
    if (signal?.aborted)
        fail("DOCUMENT_CANCELLED", "操作已取消。");
}
export function jsonBytes(value) {
    return Buffer.byteLength(JSON.stringify(value));
}
//# sourceMappingURL=errors.js.map