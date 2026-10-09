/** Non-preemptive image scheduling; explicit reads precede queued search work. */
export interface ImageJob {
    done: Promise<void>;
    promote(): void;
}
export declare class ImageQueue {
    private occupied;
    private pending;
    enqueue(task: () => Promise<void>, limit: number, signal: AbortSignal, priority?: boolean): ImageJob;
    private drain;
}
