export class ImageQueue {
    occupied = 0;
    pending = [];
    enqueue(task, limit, signal, priority = false) {
        let item;
        const done = new Promise((resolve, reject) => {
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
            if (signal.aborted)
                cancel();
            else
                this.drain();
        });
        return {
            done,
            promote: () => {
                item.priority = true;
                this.drain();
            },
        };
    }
    drain() {
        this.pending.sort((a, b) => Number(b.priority) - Number(a.priority));
        while (this.pending.length && this.occupied < this.pending[0].limit) {
            this.pending.shift().start();
        }
    }
}
//# sourceMappingURL=image-queue.js.map