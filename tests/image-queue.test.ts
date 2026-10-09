import { test } from "node:test";
import assert from "node:assert/strict";
import { ImageQueue } from "../src/image-queue.js";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
test("image queue promotes pending jobs, preserves priority FIFO and never preempts running work", async () => {
  const queue = new ImageQueue(),
    signal = new AbortController().signal;
  const running = gate(),
    order: string[] = [];
  const first = queue.enqueue(
    async () => {
      order.push("running");
      await running.wait;
    },
    1,
    signal,
  );
  const ordinary = queue.enqueue(
    async () => {
      order.push("ordinary");
    },
    1,
    signal,
  );
  const promoted = queue.enqueue(
    async () => {
      order.push("promoted");
    },
    1,
    signal,
  );
  promoted.promote();
  promoted.promote();
  const urgent = queue.enqueue(
    async () => {
      order.push("urgent");
    },
    1,
    signal,
    true,
  );
  await tick();
  assert.deepEqual(order, ["running"]);
  running.release();
  await Promise.all([first.done, ordinary.done, promoted.done, urgent.done]);
  assert.deepEqual(order, ["running", "promoted", "urgent", "ordinary"]);
});
test("image queue cancels queued jobs and recovers slots after task failures", async () => {
  const queue = new ImageQueue(),
    signal = new AbortController().signal;
  const running = gate(),
    cancel = new AbortController();
  const first = queue.enqueue(() => running.wait, 1, signal);
  const cancelled = queue.enqueue(
    async () => {
      assert.fail("cancelled task started");
    },
    1,
    cancel.signal,
    true,
  );
  const rejected = assert.rejects(cancelled.done);
  cancel.abort();
  await rejected;
  const failure = queue.enqueue(
    async () => {
      throw Error("failed");
    },
    1,
    signal,
  );
  const failed = assert.rejects(failure.done, /failed/);
  let completed = false;
  const last = queue.enqueue(
    async () => {
      completed = true;
    },
    1,
    signal,
  );
  running.release();
  await Promise.all([first.done, failed, last.done]);
  assert.equal(completed, true);
});
test("image queue respects the concurrent image limit", async () => {
  const queue = new ImageQueue(),
    signal = new AbortController().signal;
  const slots = [gate(), gate(), gate()];
  let active = 0,
    peak = 0;
  const jobs = slots.map((slot) =>
    queue.enqueue(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await slot.wait;
        active--;
      },
      2,
      signal,
    ),
  );
  await tick();
  assert.equal(active, 2);
  slots[0]!.release();
  await tick();
  assert.equal(active, 2);
  slots.forEach((s) => s.release());
  await Promise.all(jobs.map((j) => j.done));
  assert.equal(peak, 2);
});
