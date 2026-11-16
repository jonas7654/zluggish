import type { ActivityChart, PowerBests } from '#src/repositories/fit-decoder.repository';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

type Task = 'chart' | 'powerBests';

type Json = z.infer<ReturnType<typeof z.json>>;

type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void };

const response = z.object({
  id: z.number(),
  duration: z.number(),
  error: z.string().optional(),
  result: z.json().optional(),
});

const chartSchema = z.object({
  powerInWatts: z.array(z.number()),
  cadencePerMin: z.array(z.number()),
  heartRate: z.array(z.number()),
  distanceInCm: z.array(z.number()),
  speedInCmPerSec: z.array(z.number()),
  timeInSec: z.array(z.number()),
  altitudeInCm: z.array(z.number()),
  latlng: z.array(z.array(z.number())),
});

const bestsSchema = z.object({
  timestamp: z.number(),
  bests: z.array(z.object({ time: z.number(), power: z.number() })),
});

export class FitQueueFullError extends Error {
  constructor() {
    super('FIT processing queue is full');
  }
}

/** One FIT worker thread with a bounded queue of pending tasks. The worker starts
on first use and does not keep the process alive.
*/
export class FitRepository {
  private worker: Worker | null = null;

  private next = 0;

  private readonly pending = new Map<number, Pending>();

  constructor(readonly limit = 32) {}

  get queued() {
    return this.pending.size;
  }

  async chart(bytes: Uint8Array): Promise<ActivityChart> {
    return chartSchema.parse(await this.run('chart', bytes));
  }

  async powerBests(bytes: Uint8Array): Promise<PowerBests> {
    return bestsSchema.parse(await this.run('powerBests', bytes));
  }

  private run(task: Task, bytes: Uint8Array): Promise<Json> {
    if (this.pending.size >= this.limit) {
      metrics.record(Metric.QueueRejected, 1);

      return Promise.reject(new FitQueueFullError());
    }

    metrics.record(Metric.QueueDepth, this.pending.size + 1);
    const worker = this.start();
    const id = this.next++;

    // The caller keeps the canonical payload. Copy it into a dedicated buffer and
    // transfer that buffer, so the worker owns it without a second copy.
    const copy = metrics.time(Metric.FitCopy, () => new Uint8Array(bytes));
    const result = Promise.withResolvers<Json>();
    this.pending.set(id, { resolve: result.resolve, reject: result.reject });
    worker.ref();
    worker.postMessage({ id, task, bytes: copy }, [copy.buffer]);

    return result.promise;
  }

  private start() {
    if (this.worker) return this.worker;
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = new Worker(new URL(`fit.worker.${extension}`, import.meta.url));
    worker.unref();

    worker.on('message', (message) => {
      const parsed = response.parse(message);
      const pending = this.pending.get(parsed.id);
      this.pending.delete(parsed.id);
      metrics.record(Metric.FitProcessing, parsed.duration);

      if (this.pending.size === 0) worker.unref();

      if (!pending) return;

      if (parsed.error === undefined) pending.resolve(parsed.result ?? null);
      else pending.reject(new Error(parsed.error));
    });

    worker.on('error', (error) => this.fail(error));
    worker.on('exit', () => this.fail(new Error('FIT worker stopped')));
    this.worker = worker;

    return worker;
  }

  private fail(error: Error) {
    this.worker = null;

    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }
}

/** Process-wide pool: FIT processing is CPU work shared by all runtimes. */
export const fitWorkers = new FitRepository();
