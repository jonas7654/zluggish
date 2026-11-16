import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';

const options = z.object({ path: z.string(), intervalMs: z.number(), thresholdBytes: z.number() }).parse(workerData);

// A second connection checkpoints, so the main thread never copies WAL pages.
// PASSIVE does not wait for readers or writers; a long reader only delays progress.
const db = new DatabaseSync(options.path, { timeout: 1000 });
let last = performance.now();

const timer = setInterval(() => {
  const wal = `${options.path}-wal`;
  const walBytes = existsSync(wal) ? statSync(wal).size : 0;
  const due = walBytes >= options.thresholdBytes || (walBytes > 0 && performance.now() - last >= 60_000);

  if (!due) {
    parentPort?.postMessage({ walBytes, durationMs: null });

    return;
  }

  const start = performance.now();

  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {
    // A busy database retries at the next interval.
  }

  last = performance.now();
  parentPort?.postMessage({ walBytes, durationMs: last - start });
}, options.intervalMs);

parentPort?.on('message', () => {
  clearInterval(timer);
  db.close();
  parentPort?.close();
});
