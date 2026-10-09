/** Expected failures carry a stable code and a credential-free explanation. */
export class DocumentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DocumentError";
  }
}
export function fail(code: string, message: string): never {
  throw new DocumentError(code, message);
}
export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail("DOCUMENT_CANCELLED", "操作已取消。");
}
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
