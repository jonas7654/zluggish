import type { JobType } from '#src/enum';
import type { RepositoryContext } from '#src/context';
import { JobError } from '#src/errors';
import { RunningJob } from '#src/repositories/jobs.repository';
import type { Claim, JobPayload } from '#src/repositories/jobs.repository';
import { SystemFlag } from '#src/repositories/system-flag.repository';
import { BaseService } from '#src/services/base.service';

export type JobHandler = {
  concurrency: number;
  attempts: number;
  timeoutMs: number;
  run: (job: RunningJob) => Promise<void>;
};

const leaseMs = 30_000;

/** In-process runner for the job table. One process owns the table; leases and claim
tokens fence handlers that outlive their lease.
*/
export class JobsService extends BaseService {
  private readonly handlers = new Map<JobType, JobHandler>();

  private readonly active = new Map<JobType, number>();

  private readonly running = new Set<Promise<void>>();

  private readonly controllers = new Set<AbortController>();

  private timer: NodeJS.Timeout | null = null;

  private status: 'idle' | 'running' | 'stopped' = 'idle';

  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
    this.jobsRepository.notify = () => this.kick();
  }

  register(type: JobType, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  enqueue(type: JobType, payload: JobPayload, delayMs = 0) {
    return this.jobsRepository.enqueue(type, payload, delayMs);
  }

  start(intervalMs = 1000) {
    if (this.status === 'stopped' || this.timer) return;
    this.status = 'running';
    this.timer = setInterval(() => this.poll(), intervalMs);
    this.timer.unref();
    this.poll();
  }

  /** True while a handler runs or a ready job waits. */
  get busy() {
    if (this.running.size > 0) return true;
    const ready = this.jobsRepository.ready();

    return this.handlers.keys().some((type) => ready.has(type) && !this.paused(type));
  }

  private kicked = false;

  /** Poll soon, after the current transaction commits. Kicks in one turn share one poll. */
  kick() {
    if (this.status !== 'running' || this.kicked) return;
    this.kicked = true;
    setImmediate(() => {
      this.kicked = false;
      this.poll();
    });
  }

  private paused(type: JobType) {
    return type === 'delivery' && this.systemFlagsRepository.get(SystemFlag.UploadPause) !== null;
  }

  private poll() {
    if (this.status !== 'running') return;
    const ready = this.jobsRepository.ready();

    for (const [type, handler] of this.handlers) {
      if (!ready.has(type) || this.paused(type)) continue;

      while ((this.active.get(type) ?? 0) < handler.concurrency) {
        const claim = this.jobsRepository.claim(type, leaseMs);

        if (!claim) break;
        this.launch(claim, handler);
      }
    }
  }

  private launch(claim: Claim, handler: JobHandler) {
    this.active.set(claim.type, (this.active.get(claim.type) ?? 0) + 1);

    const run = this.execute(claim, handler).finally(() => {
      this.active.set(claim.type, (this.active.get(claim.type) ?? 1) - 1);
      this.running.delete(run);
      this.kick();
    });

    this.running.add(run);
  }

  private async execute(claim: Claim, handler: JobHandler) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const job = new RunningJob(claim, controller.signal, this.jobsRepository);

    // Renew while the handler runs. A failed renewal stops the handler: another claim
    // may own the job now.
    const renewal = setInterval(() => {
      if (!this.jobsRepository.renew(claim, leaseMs)) controller.abort(new JobError('lease_lost'));
    }, leaseMs / 3);

    const timeout = setTimeout(() => controller.abort(new JobError('timeout')), handler.timeoutMs);

    try {
      await handler.run(job);

      if (!job.done) job.commit();
    } catch (error) {
      const code = error instanceof JobError ? error.code : error instanceof Error ? error.name : 'error';
      const retry = !(error instanceof JobError) || error.retry;

      // A stop is not a failure: the job runs again after the next start.
      if (this.status === 'stopped') this.jobsRepository.retry(claim, code, 0);
      else if (retry && claim.attempts < handler.attempts)
        this.jobsRepository.retry(claim, code, Math.min(3_600_000, 1000 * 4 ** claim.attempts));
      else this.jobsRepository.fail(claim, code);

      this.context.world.lifecycle.log.warn('job.failed', 'Background job failed', {
        jobId: claim.id,
        type: claim.type,
        attempts: claim.attempts,
        code,
      });
    } finally {
      clearInterval(renewal);
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  /** Run one claimed job now, outside the polling loop. */
  run(claim: Claim) {
    const handler = this.handlers.get(claim.type);

    if (!handler) throw new Error('No handler for this job type');

    return this.execute(claim, handler);
  }

  /** Run every ready job until none is left. For tests and offline commands. */
  async drain() {
    const status = this.status;
    this.status = 'running';

    try {
      for (;;) {
        this.poll();

        if (this.running.size === 0) return;
        await Promise.all(this.running);
      }
    } finally {
      if (this.status === 'running') this.status = status;
    }
  }

  async close() {
    this.status = 'stopped';

    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    for (const controller of this.controllers) controller.abort(new JobError('shutdown'));
    await Promise.allSettled(this.running);
  }
}
