/** Non-preemptive image scheduling; explicit reads precede queued search work. */
export interface ImageJob {
  done: Promise<void>;
  promote(): void;
}
interface Pending {
  priority: boolean;
  limit: number;
  start(): void;
}
export class ImageQueue {
  private occupied = 0;
  private pending: Pending[] = [];

  enqueue(
    task: () => Promise<void>,
    limit: number,
    signal: AbortSignal,
    priority = false,
  ): ImageJob {
    let item: Pending;
    const done = new Promise<void>((resolve, reject) => {
      const cancel = () => {
        this.pending = this.pending.filter((p) => p !== item);
        signal.removeEventListener("abort", cancel);
        reject(signal.reason);
        this.drain();
      };
      item = {
        priority,
        limit,
        start: () => {
          signal.removeEventListener("abort", cancel);
          this.occupied++;
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              this.occupied--;
              this.drain();
            });
        },
      };
      this.pending.push(item);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else this.drain();
    });
    return {
      done,
      promote: () => {
        item.priority = true;
        this.drain();
      },
    };
  }
  private drain(): void {
    this.pending.sort((a, b) => Number(b.priority) - Number(a.priority));
    while (this.pending.length && this.occupied < this.pending[0]!.limit) {
      this.pending.shift()!.start();
    }
  }
}
