import { FitDecoder } from '#src/repositories/fit-decoder.repository';
import { parentPort } from 'node:worker_threads';
import { z } from 'zod';

const request = z.object({ id: z.number(), task: z.enum(['chart', 'powerBests']), bytes: z.instanceof(Uint8Array) });

const decoder = new FitDecoder();

parentPort?.on('message', (message) => {
  const { id, task, bytes } = request.parse(message);
  const start = performance.now();

  try {
    const result = task === 'chart' ? decoder.chart(bytes) : decoder.powerBests(bytes);
    parentPort?.postMessage({ id, result, duration: performance.now() - start });
  } catch {
    parentPort?.postMessage({ id, error: 'Invalid FIT activity', duration: performance.now() - start });
  }
});
