import { RuntimeContext } from '#src/context';
import { JobType } from '#src/enum';
import { publishBackup, pruneNightlyBackups } from '#src/migrations/backup';
import { nightlyBackupName } from '#src/migrations/backup-paths';
import { JobsService } from '#src/services/jobs.service';
import { Context, Effect, Layer } from 'effect';

const type = JobType.StorageBackup;
const manualName = (operation: string) => `manual-${operation}`;

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const jobs = yield* JobsService;
  const repository = context.accounts.repositories.jobsRepository;
  const storage = context.config.storageDir;

  function scheduleNightly() {
    const now = repository.now();
    const next = new Date(now);
    next.setUTCHours(2, 0, 0, 0);

    if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
    const nightlyAt = next.getTime();
    repository.enqueueOnce(type, { nightlyAt }, nightlyAt - now);
  }

  yield* jobs.register(type, {
    concurrency: 1,
    attempts: 3,
    timeoutMs: 60 * 60 * 1000,
    run: (job) =>
      Effect.tryPromise({
        try: async () => {
          const nightly = job.payload.nightlyAt !== undefined;

          const name = nightly
            ? nightlyBackupName(new Date(job.number('nightlyAt')))
            : manualName(job.text('operation'));

          // Schedule the next night even if this backup fails all its retries.
          if (nightly) scheduleNightly();
          await publishBackup(storage, context.configPath ?? null, name, job.signal);

          if (nightly) await pruneNightlyBackups(storage);
          context.world.lifecycle.log.info('storage.backup', 'Storage backup finished', { name });
        },
        catch: (error) => error,
      }),
  });

  return {
    schedule: Effect.fn('BackupService.schedule')(function* () {
      scheduleNightly();
    }),
    request: Effect.fn('BackupService.request')(function* (operation: string) {
      const payload = { operation };
      const state = repository.stateFor(type, payload);

      if (state) return { state, name: manualName(operation) };
      repository.enqueue(type, payload);

      return { state: 'queued', name: manualName(operation) };
    }),
    status: Effect.fn('BackupService.status')(function* (operation: string) {
      const state = repository.stateFor(type, { operation });

      return state ? { state, name: manualName(operation) } : null;
    }),
  };
});

export class BackupService extends Context.Service<BackupService, Effect.Success<typeof make>>()(
  'zluggish/BackupService',
) {
  static readonly layer = Layer.effect(BackupService, make);
}
