import type { ResolvedConfig } from '#src/config/index';
import { immediate } from '#src/db/transaction';
import { RiderDocumentName } from '#src/enum';
import type { BaseServiceDeps } from '#src/services/base.service';
import { BaseService } from '#src/services/base.service';
import type { JobsService } from '#src/services/jobs.service';
import { resolve } from 'node:path';

const hour = 3_600_000;
const day = 24 * hour;

/** A media reservation older than its upload token is abandoned. */
const reservationMs = hour;

export type RetentionCandidate = { path: string; bytes: number; reason: string };

export type RetentionPlan = {
  jobs: number;
  deliveries: number;
  media: { table: 'activity_image' | 'activity_media'; id: number }[];
  files: RetentionCandidate[];
};

export type StorageUsage = Record<
  'database' | 'media' | 'fitExports' | 'charts' | 'ghosts' | 'backups' | 'legacy' | 'other',
  number
>;

/** Storage growth limits. Never removes unfinished deliveries, retry dependencies or the
canonical FIT payload: those live in the database and only finished rows qualify.
*/
export class RetentionService extends BaseService {
  constructor(
    repositories: BaseServiceDeps,
    private readonly retention: ResolvedConfig['retention'],
    private readonly storage: string,
  ) {
    super(repositories);
  }

  /** What a cleanup would remove now, without removing anything. */
  async plan(now = Date.now()): Promise<RetentionPlan> {
    const files: RetentionCandidate[] = [];
    const owners = this.activitiesRepository.owners();

    const add = async (path: string, reason: string) => {
      const info = await this.filesRepository.statAsync(path);

      if (info) files.push({ path, bytes: info.bytes, reason });
    };

    const media = [
      ...this.activitiesRepository
        .abandonedMedia('activity_image', now - reservationMs)
        .map((row) => ({ table: 'activity_image' as const, ...row })),
      ...this.activitiesRepository
        .abandonedMedia('activity_media', now - reservationMs)
        .map((row) => ({ table: 'activity_media' as const, ...row })),
    ];

    for (const row of media) {
      const folder = resolve(this.storage, String(row.player_id));

      if (row.table === 'activity_image') await add(resolve(folder, 'images', `${row.id}.jpg`), 'abandoned upload');
      else
        for (const extension of ['mp4', 'mov'])
          await add(resolve(folder, 'medias', `${row.id}.${extension}`), 'abandoned upload');
    }

    const abandoned = new Set(media.map((row) => `${row.table}:${row.id}`));

    for (const entry of await this.filesRepository.entriesAsync(resolve(this.storage, 'activities')))
      if (entry.isFile() && /^\d+$/.test(entry.name) && !owners.charts.has(Number(entry.name)))
        await add(resolve(this.storage, 'activities', entry.name), 'orphaned chart');

    for (const rider of await this.filesRepository.entriesAsync(this.storage)) {
      if (!rider.isDirectory() || !/^\d+$/.test(rider.name)) continue;
      const folder = resolve(this.storage, rider.name);

      for (const entry of await this.filesRepository.entriesAsync(resolve(folder, 'fit'))) {
        const activity = /^(\d+) - /.exec(entry.name)?.[1];

        if (activity !== undefined && !owners.activities.has(Number(activity)))
          await add(resolve(folder, 'fit', entry.name), 'orphaned FIT export');
      }

      for (const [directory, table, owned] of [
        ['images', 'activity_image', owners.images],
        ['medias', 'activity_media', owners.media],
      ] as const)
        for (const entry of await this.filesRepository.entriesAsync(resolve(folder, directory))) {
          const id = /^(\d+)\.\w+$/.exec(entry.name)?.[1];

          if (id !== undefined && !owned.has(Number(id)) && !abandoned.has(`${table}:${id}`))
            await add(resolve(folder, directory, entry.name), 'orphaned media');
        }

      await this.ghosts(resolve(folder, 'ghosts'), files);
    }

    for (const path of await this.filesRepository.filesUnder(this.storage, '.tmp')) {
      if (path.startsWith(resolve(this.storage, 'backups'))) continue;
      const info = await this.filesRepository.statAsync(path);

      if (info && info.modified < now - this.retention.temporaryFileHours * hour)
        files.push({ path, bytes: info.bytes, reason: 'temporary file' });
    }

    const entries = await this.filesRepository.entriesAsync(resolve(this.storage, 'backups'));

    const backups = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('storage-v'))
      .map((entry) => entry.name)
      .toSorted()
      .toReversed();

    for (const name of backups.slice(this.retention.migrationBackups))
      files.push({
        path: resolve(this.storage, 'backups', name),
        bytes: await this.size(resolve(this.storage, 'backups', name)),
        reason: 'old migration backup',
      });

    return {
      jobs: this.jobsRepository.prunable(now - this.retention.finishedJobsDays * day),
      deliveries: this.uploadsRepository.prunable(now - this.retention.deliveryRecordsDays * day),
      media: media.map((row) => ({ table: row.table, id: row.id })),
      files,
    };
  }

  /** Keep the newest recordings in each ghost directory. */
  private async ghosts(directory: string, files: RetentionCandidate[]) {
    const entries = await this.filesRepository.entriesAsync(directory);
    const recordings = [];

    for (const entry of entries) {
      const path = resolve(directory, entry.name);

      if (entry.isDirectory()) await this.ghosts(path, files);
      else if (entry.name.endsWith('.bin')) {
        const info = await this.filesRepository.statAsync(path);

        if (info) recordings.push({ path, ...info });
      }
    }

    for (const old of recordings.toSorted((a, b) => b.modified - a.modified).slice(this.retention.ghostsPerRoute))
      files.push({ path: old.path, bytes: old.bytes, reason: 'old ghost recording' });
  }

  async apply(plan: RetentionPlan, now = Date.now()) {
    immediate(this.repositories.db, () => {
      this.jobsRepository.prune(now - this.retention.finishedJobsDays * day);
      this.uploadsRepository.prune(now - this.retention.deliveryRecordsDays * day);

      for (const row of plan.media) this.activitiesRepository.deleteMedia(row.table, row.id);
    });

    for (const file of plan.files) await this.filesRepository.removeTreeAsync(file.path);

    return { files: plan.files.length, bytes: plan.files.reduce((total, file) => total + file.bytes, 0) };
  }

  private async size(path: string): Promise<number> {
    const info = await this.filesRepository.statAsync(path);

    if (!info) return 0;

    if (!info.directory) return info.bytes;
    let total = 0;

    for (const entry of await this.filesRepository.entriesAsync(path))
      total += await this.size(resolve(path, entry.name));

    return total;
  }

  /** Bytes by category, for the operator. */
  async usage(): Promise<StorageUsage> {
    const usage: StorageUsage = {
      database: 0,
      media: 0,
      fitExports: 0,
      charts: 0,
      ghosts: 0,
      backups: 0,
      legacy: 0,
      other: 0,
    };

    const legacy = new Set<string>([...Object.values(RiderDocumentName), 'bookmarks']);

    const top = new Map<string, keyof StorageUsage>([
      ['backups', 'backups'],
      ['activities', 'charts'],
      ['settings.db', 'legacy'],
    ]);

    const rider = new Map<string, keyof StorageUsage>([
      ['images', 'media'],
      ['medias', 'media'],
      ['fit', 'fitExports'],
      ['ghosts', 'ghosts'],
      ['garth', 'legacy'],
    ]);

    for (const entry of await this.filesRepository.entriesAsync(this.storage)) {
      const path = resolve(this.storage, entry.name);

      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        const category = entry.name.startsWith('zluggish.db') ? 'database' : (top.get(entry.name) ?? 'other');
        usage[category] += await this.size(path);
        continue;
      }

      for (const item of await this.filesRepository.entriesAsync(path))
        usage[rider.get(item.name) ?? (legacy.has(item.name) ? 'legacy' : 'other')] += await this.size(
          resolve(path, item.name),
        );
    }

    return usage;
  }

  /** A daily job. Each run schedules the next one when it commits. */
  registerJobs(jobs: JobsService) {
    jobs.register('retention', {
      concurrency: 1,
      attempts: 3,
      timeoutMs: 600_000,
      run: async (job) => {
        const plan = await this.plan();
        const removed = await this.apply(plan);

        job.commit(() => this.jobsRepository.enqueue('retention', {}, day));
        this.loggingRepository.info('storage.retention', 'Storage cleanup finished', {
          files: removed.files,
          bytes: removed.bytes,
          jobs: plan.jobs,
          deliveries: plan.deliveries,
          media: plan.media.length,
        });
      },
    });
  }

  /** Make sure one retention job is queued. */
  schedule() {
    this.jobsRepository.enqueueOnce('retention', {});
  }
}
