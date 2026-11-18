import { activityMediaSchema } from '#src/dtos/activities.dto';
import { type RepositoryContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import { ActivitySchema, FitnessPrivacy, type Activity } from '#src/protocol/generated/activity_pb';
import { ActivityPrivacyType, Sport, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { GhostSchema, WA_TYPE, WorldAttributeSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { ActivitiesRepository } from '#src/repositories/activities.repository';
import { immediate } from '#src/db/transaction';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import { BaseService } from '#src/services/base.service';
import type { RunningJob } from '#src/repositories/jobs.repository';
import type { JobsService } from '#src/services/jobs.service';
import { FitService } from '#src/services/fit.service';
import { SettingsService } from '#src/services/settings.service';
import { StreakService } from '#src/services/streak.service';
import { UploadsService } from '#src/services/uploads.service';
import { course, worldTime } from '#src/world/state';
import { clearField, clone, create, toBinary } from '@bufbuild/protobuf';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

/** Comma-separated identifiers in a job payload. */
function identifiers(job: RunningJob, key: string) {
  return job.text(key).split(',').filter(Boolean);
}

function ids(rows: { id: number }[]) {
  return rows.map((row) => row.id).join(',');
}

export class ActivitiesService extends BaseService {
  private readonly mediaTokens = new Map<string, { token: Buffer; expires: number; status: 'issued' | 'receiving' }>();

  issueMedia(id: string) {
    for (const [key, entry] of this.mediaTokens) if (entry.expires < Date.now()) this.mediaTokens.delete(key);

    const entry = {
      token: this.cryptoRepository.randomBytes(32),
      expires: Date.now() + 900_000,
      status: 'issued' as const,
    };

    this.mediaTokens.set(id, entry);

    return entry;
  }

  /** issued -> receiving -> consumed; a failed write releases the claim for retry.
  Validate again after reading the body: deleting the activity must not recreate its media.
  */
  async receiveMedia(id: string, token: Buffer, read: () => Promise<ArrayBuffer>) {
    const entry = this.mediaTokens.get(id);

    if (
      !entry ||
      entry.status !== 'issued' ||
      entry.expires < Date.now() ||
      token.length !== entry.token.length ||
      !this.cryptoRepository.timingSafeEqual(token, entry.token)
    )
      throw new ApplicationError({ status: 403 });
    entry.status = 'receiving';

    try {
      if (!this.activitiesRepository.findActivityMedia(id)) throw new ApplicationError({ status: 404 });
      const bytes = new Uint8Array(await read());

      if (this.mediaTokens.get(id) !== entry || entry.expires < Date.now()) throw new ApplicationError({ status: 403 });
      const row = activityMediaSchema.safeParse(this.activitiesRepository.findActivityMedia(id));

      if (!row.success) throw new ApplicationError({ status: 404 });
      const extension = row.data.content_type.includes('quicktime') ? 'mov' : 'mp4';
      const path = resolve(this.context.profiles.folder(row.data.player_id), 'medias', `${id}.${extension}`);
      await this.filesRepository.writeDurableAsync(path, bytes, true);

      // The file is durable before the row is ready. The activity can be deleted while
      // the write runs: then the file is removed, not kept as an orphan.
      if (!this.activitiesRepository.mediaState('activity_media', id, 'ready')) {
        await this.filesRepository.removeAsync(path);
        throw new ApplicationError({ status: 404 });
      }

      this.mediaTokens.delete(id);
    } catch (error) {
      if (this.mediaTokens.get(id) === entry) entry.status = 'issued';
      throw error;
    }
  }

  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  /** A completed activity is immutable: the same save returns the existing result;
  a changed payload or FIT payload is a conflict.
  */
  finalized(activity: Activity) {
    const saved = this.completionRepository.get(activity.id);

    if (!saved) return false;
    const stored = this.activitiesRepository.fit(activity.id)?.fit ?? new Uint8Array();

    if (
      !Buffer.from(saved.payload).equals(
        Buffer.from(toBinary(ActivitySchema, ActivitiesService.withoutFit(activity))),
      ) ||
      !Buffer.from(stored).equals(Buffer.from(activity.fit))
    )
      throw new ApplicationError({ status: 409, message: 'Completed activities cannot be replaced.' });

    return true;
  }

  static withoutFit(activity: Activity) {
    const stripped = clone(ActivitySchema, activity);
    clearField(stripped, ActivitySchema.field.fit);

    return stripped;
  }

  private turn = Promise.resolve();

  private queued = 0;

  /** Saves from requests run one per event-loop turn: a group of riders that finish
  together cannot hold the main thread for the whole group.
  */
  saveInTurn(activity: Activity, finish: boolean, validate: () => boolean | void = () => {}) {
    const queued = performance.now();
    metrics.record(Metric.QueueDepth, ++this.queued);

    const result = this.turn
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => {
        this.queued--;
        metrics.record(Metric.QueueWait, performance.now() - queued);

        if (validate() === false) return 'unchanged';

        return this.save(activity, finish);
      });

    this.turn = result.then(() => {}).catch(() => {});

    return result;
  }

  /** Draft edits, durable completion and discard are distinct from ending a ride. */
  save(activity: Activity, finish: boolean) {
    if (this.finalized(activity)) return 'unchanged';

    if (!finish) {
      this.protobufRepository.update('activity', activity.id, ActivitySchema, activity, ['fit']);

      return 'updated';
    }

    if (activity.distanceInMeters < 1) {
      this.deleteActivity(activity.id, Number(activity.playerId));
      this.context.world.lifecycle.log.info('activity.discarded', 'Activity discarded', {
        playerId: Number(activity.playerId),
        activityId: activity.id,
      });

      return 'discarded';
    }

    this.finalize(activity);

    return 'completed';
  }

  finalize(activity: Activity) {
    try {
      if (!this.complete(activity)) return;
    } catch (error) {
      this.context.world.lifecycle.log.error('activity.save_failed', 'Activity save failed', {
        playerId: activity.playerId,
        activityId: activity.id,
        recoverable: true,
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }

    this.context.world.lifecycle.log.info('activity.saved', 'Activity saved', {
      playerId: activity.playerId,
      activityId: activity.id,
    });
  }

  /** One transaction commits the activity, its canonical FIT payload, progression, the
  completion record, delivery records and the jobs that publish optional artifacts.
  Provider requests, FIT processing and file writes run after the commit.
  */
  private complete(activity: Activity) {
    const player = Number(activity.playerId);
    const id = Number(activity.id);
    const history = this.context.world.histories.get(activity.playerId) ?? [];

    const settings = SettingsService.resolveRiderSettings(
      this.context.config.riderDefaults,
      this.context.settings.read(player),
    );

    const providers = new UploadsService(this.context).configured(player);
    const progresses = activity.sport === Sport.CYCLING && activity.distanceInMeters >= 2000;

    const committed = immediate(this.repositories.db, () => {
      // A concurrent finalization committed first: return its result unchanged.
      if (this.finalized(activity)) return null;
      this.protobufRepository.update('activity', activity.id, ActivitySchema, activity, ['fit']);
      this.activitiesRepository.setFit(activity.id, activity.fit);

      const advanced = progresses
        ? StreakService.advancedStreak(new StreakService(this.repositories).streaksFor(player), activity)
        : null;

      if (advanced) this.streakRepository.saveStreaks(player, advanced);
      const snapshot = advanced ? toBinary(StreaksSchema, advanced) : null;

      this.completionRepository.insert(
        activity.id,
        player,
        toBinary(ActivitySchema, ActivitiesService.withoutFit(activity)),
        snapshot,
      );

      for (const provider of providers)
        if (this.uploadsRepository.insert(id, provider))
          this.jobsRepository.enqueue('delivery', { activityId: id, provider });

      if (activity.fit.length > 0) {
        this.jobsRepository.enqueue('power_curve', { activityId: id });
        this.jobsRepository.enqueue('fit_export', { activityId: id });
        const file = Number(this.activitiesRepository.insertActivityFile(activity.id).lastInsertRowid);
        this.jobsRepository.enqueue('chart', { activityId: id, fileId: file });
      }

      return { streak: snapshot };
    });

    if (!committed) return false;

    // The ghost recording is an optional artifact from memory: written after the
    // commit, off the main thread. A crash before the write loses only the recording.
    const state = history.at(-1);

    if (state && settings.ghosts.enabled)
      void this.filesRepository
        .writeDurableAsync(
          resolve(
            this.context.profiles.folder(player),
            'ghosts',
            String(course(state)),
            ...(state.route
              ? [String(state.route)]
              : [String((state.aux3 >>> 8) & 0xff_ff), ...(state.f19 & 4 ? [] : ['reverse'])]),
            `activity-${activity.id}.bin`,
          ),
          toBinary(GhostSchema, create(GhostSchema, { playerId: player, states: history })),
          true,
        )
        .catch(() => {
          this.context.world.lifecycle.log.warn('activity.ghost_unavailable', 'Ghost recording not saved', {
            activityId: activity.id,
            playerId: activity.playerId,
          });
        });

    if (committed.streak)
      this.context.world.enqueue(
        create(WorldAttributeSchema, {
          serverRealm: 1n,
          waType: WA_TYPE.PLAYER_FITNESS_METRICS_UPDATED,
          worldTimeBorn: worldTime(),
          worldTimeExpire: worldTime() + 60_000n,
          timestamp: BigInt(Date.now()) * 1000n,
        }),
        [activity.playerId],
      );

    return true;
  }

  findActivity(...values: Parameters<ActivitiesRepository['findActivity']>) {
    return this.activitiesRepository.findActivity(...values);
  }

  /** The rows go in one transaction with a cleanup job; the job removes the files.
  Historical streak and power-curve contributions stay.
  */
  deleteActivity(id: bigint, player: number) {
    immediate(this.repositories.db, () => {
      if (!this.activitiesRepository.findActivity(id, player)) throw new ApplicationError({ status: 404 });

      const payload = {
        activityId: Number(id),
        playerId: player,
        charts: ids(z.array(z.object({ id: z.number() })).parse(this.activitiesRepository.listActivityFile(id))),
        images: ids(
          z.array(z.object({ id: z.number() })).parse(this.activitiesRepository.listActivityImage(player, id)),
        ),
        media: ids(
          z.array(z.object({ id: z.number() })).parse(this.activitiesRepository.listActivityMedia(player, id)),
        ),
      };

      this.activitiesRepository.deleteActivityData(id, player);
      this.jobsRepository.enqueue('artifact_cleanup', payload);
    });
  }

  visible(activity: Activity, viewer: number) {
    return (
      activity.playerId === BigInt(viewer) ||
      (!activity.privateActivity && activity.privacy === ActivityPrivacyType.PUBLIC)
    );
  }

  fitnessVisible(activity: Activity, viewer: number) {
    return (
      this.visible(activity, viewer) &&
      (activity.playerId === BigInt(viewer) || activity.fitnessPrivacy !== FitnessPrivacy.HIDE_SENSITIVE_DATA)
    );
  }

  forViewer(activity: Activity, viewer: number) {
    if (!this.visible(activity, viewer)) throw new ApplicationError({ status: 404 });

    if (this.fitnessVisible(activity, viewer)) return activity;

    // Construct a public summary: unknown/future protobuf fields must not leak either.
    return create(ActivitySchema, {
      id: activity.id,
      playerId: activity.playerId,
      courseId: activity.courseId,
      name: activity.name,
      startDate: activity.startDate,
      endDate: activity.endDate,
      distanceInMeters: activity.distanceInMeters,
      totalElevation: activity.totalElevation,
      sport: activity.sport,
      date: activity.date,
      privacy: activity.privacy,
      fitnessPrivacy: activity.fitnessPrivacy,
      movingTimeInMs: activity.movingTimeInMs,
    });
  }

  findActivityFile(...values: Parameters<ActivitiesRepository['findActivityFile']>) {
    return this.activitiesRepository.findActivityFile(...values);
  }

  insertActivityFile(...values: Parameters<ActivitiesRepository['insertActivityFile']>) {
    return this.activitiesRepository.insertActivityFile(...values);
  }

  findOwnedActivityFile(...values: Parameters<ActivitiesRepository['findOwnedActivityFile']>) {
    return this.activitiesRepository.findOwnedActivityFile(...values);
  }

  /** Reserve the row, write the file durably, then mark the row ready. */
  async saveImage(player: number, activity: string, jpg: Uint8Array) {
    const id = Number(this.activitiesRepository.insertActivityImage(player, activity).lastInsertRowid);
    const path = resolve(this.context.profiles.folder(player), 'images', `${id}.jpg`);

    try {
      await this.filesRepository.writeDurableAsync(path, jpg, true);
    } catch (error) {
      this.activitiesRepository.mediaState('activity_image', id, 'failed');
      throw error;
    }

    if (!this.activitiesRepository.mediaState('activity_image', id, 'ready')) {
      await this.filesRepository.removeAsync(path);
      throw new ApplicationError({ status: 404 });
    }

    return id;
  }

  insertActivityMedia(...values: Parameters<ActivitiesRepository['insertActivityMedia']>) {
    return this.activitiesRepository.insertActivityMedia(...values);
  }

  findActivityMedia(...values: Parameters<ActivitiesRepository['findActivityMedia']>) {
    return this.activitiesRepository.findActivityMedia(...values);
  }

  photos(player: number, activity: bigint) {
    const folder = this.context.profiles.folder(player);

    const paths = [];

    for (const row of z
      .array(z.object({ id: z.number(), state: z.string() }))
      .parse(this.activitiesRepository.listActivityImage(player, activity)))
      if (row.state === 'ready') paths.push(resolve(folder, 'images', `${row.id}.jpg`));

    for (const row of z
      .array(z.object({ id: z.number(), content_type: z.string(), state: z.string() }))
      .parse(this.activitiesRepository.listActivityMedia(player, activity)))
      if (row.state === 'ready')
        paths.push(resolve(folder, 'medias', `${row.id}.${row.content_type.includes('quicktime') ? 'mov' : 'mp4'}`));

    return paths.filter((path) => this.filesRepository.existsSync(path));
  }

  companion(activity: Activity, details = false) {
    const profile = this.context.profiles.get(Number(activity.playerId));

    const moving = Date.parse(activity.endDate) - Date.parse(activity.startDate);

    const summary = {
      id: Number(activity.id),
      profile: {
        id: String(activity.playerId),
        firstName: profile.firstName,
        lastName: profile.lastName,
        imageSrc: profile.largeAvatarUrl || null,
        approvalRequired: null,
      },
      worldId: Number(activity.courseId),
      name: activity.name,
      sport: activity.sport === 1 ? 'RUNNING' : 'CYCLING',
      startDate: activity.startDate,
      endDate: activity.endDate,
      distanceInMeters: activity.distanceInMeters,
      totalElevation: activity.totalElevation,
      calories: activity.calories,
      primaryImageUrl: '',
      feedImageThumbnailUrl: '',
      lastSaveDate: activity.date,
      movingTimeInMs: Number.isFinite(moving) ? moving : 0,
      avgSpeedInMetersPerSecond: activity.avgSpeed,
      activityRideOnCount: 0,
      activityCommentCount: 0,
      privacy: activity.privateActivity ? 'PRIVATE' : ActivityPrivacyType[activity.privacy],
      eventId: null,
      rideOnGiven: false,
      id_str: String(activity.id),
    };

    return details
      ? {
          ...summary,
          avgWatts: activity.avgWatts,
          maxWatts: activity.maxWatts,
          avgHeartRate: activity.avgHeartRate,
          maxHeartRate: activity.maxHeartRate,
          avgCadenceInRotationsPerMinute: activity.avgCadence,
          maxCadenceInRotationsPerMinute: activity.maxCadence,
          maxSpeedInMetersPerSecond: activity.maxSpeed,
        }
      : summary;
  }

  /** A rider's own activities for the web app. The rider owns them, so fitness privacy does not apply. */
  own(player: number, id?: string, page?: number) {
    return this.activitiesRepository.ownActivities(player, id, page).map((row) => {
      const activity = this.protobufRepository.decode(ActivitySchema, row);
      const elapsed = Date.parse(activity.endDate) - Date.parse(activity.startDate);

      return {
        id: String(activity.id),
        name: activity.name,
        world: Number(activity.courseId),
        sport: activity.sport === Sport.RUNNING ? 'running' : 'cycling',
        startDate: activity.startDate || null,
        endDate: activity.endDate || null,
        distanceInMeters: activity.distanceInMeters,
        totalElevation: activity.totalElevation,
        movingTimeInMs: Number(activity.movingTimeInMs) || (Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0),
        calories: activity.calories,
        avgWatts: activity.avgWatts,
        maxWatts: activity.maxWatts,
        normalizedPower: activity.normalizedPower,
        tss: activity.tss,
        avgHeartRate: activity.avgHeartRate,
        maxHeartRate: activity.maxHeartRate,
        avgCadence: activity.avgCadence,
        maxCadence: activity.maxCadence,
        avgSpeed: activity.avgSpeed,
        maxSpeed: activity.maxSpeed,
        fit: Number(row.has_fit) === 1,
        images: Number(row.image_count),
      };
    });
  }

  /** One own activity with its ready images and chart. The chart is null while its job runs. */
  ownDetail(player: number, id: string) {
    const [activity] = this.own(player, id);

    if (!activity) throw new ApplicationError({ status: 404, message: 'Activity not found.' });

    const images = z
      .array(z.object({ id: z.number(), state: z.string() }))
      .parse(this.activitiesRepository.listActivityImage(player, id))
      .filter((row) => row.state === 'ready')
      .map((row) => row.id);

    const fileId = activity.fit ? this.chartFile(BigInt(id)) : null;

    const chart =
      fileId === null ? null : JSON.parse(this.filesRepository.readFileSync(this.chartPath(fileId), 'utf8'));

    return { ...activity, imageIds: images, chart, chartPending: activity.fit && chart === null };
  }

  /** The canonical FIT payload of an own activity, with a filename safe for a download header. */
  ownFit(player: number, id: string) {
    const stored = this.activitiesRepository.fit(id);

    if (!stored?.fit || stored.player !== player)
      throw new ApplicationError({ status: 404, message: 'FIT file not found.' });

    const base = stored.filename
      .normalize('NFKD')
      .replaceAll(/[^\w. -]/g, '_')
      .replace(/^[.\s]+/, '');

    return {
      fit: stored.fit,
      filename: base ? (base.toLowerCase().endsWith('.fit') ? base : `${base}.fit`) : `${id}.fit`,
    };
  }

  /** A ready image of an own activity. */
  ownImage(player: number, activity: string, image: number) {
    const ready = z
      .array(z.object({ id: z.number(), state: z.string() }))
      .parse(this.activitiesRepository.listActivityImage(player, activity))
      .some((row) => row.id === image && row.state === 'ready');

    const path = resolve(this.context.profiles.folder(player), 'images', `${image}.jpg`);

    if (!ready || !this.filesRepository.existsSync(path))
      throw new ApplicationError({ status: 404, message: 'Image not found.' });

    return this.filesRepository.readFileSync(path);
  }

  recentActivities(...values: Parameters<ActivitiesRepository['recentActivities']>) {
    return this.activitiesRepository.recentActivities(...values);
  }

  activityById(...values: Parameters<ActivitiesRepository['activityById']>) {
    return this.activitiesRepository.activityById(...values);
  }

  activityFeed(...values: Parameters<ActivitiesRepository['activityFeed']>) {
    return this.activitiesRepository.activityFeed(...values);
  }

  activityChart(...args: Parameters<typeof FitService.activityChart>) {
    return FitService.activityChart(...args);
  }

  chart(bytes: Uint8Array) {
    return FitService.chart(bytes);
  }

  savePowerCurve(id: number, bytes: Uint8Array) {
    return new FitService(this.repositories).savePowerCurve(id, bytes);
  }

  updateStreaks(id: number, activity: Activity) {
    return new StreakService(this.repositories).updateStreaks(id, activity);
  }

  /** Recreate a rider's power curves from canonical FIT payloads, as jobs. */
  rebuildPowerCurves(player: number) {
    immediate(this.repositories.db, () => {
      this.fitnessRepository.deletePowerCurve(player);

      for (const activity of this.activitiesRepository.withFit(player))
        this.jobsRepository.enqueue('power_curve', { activityId: activity });
    });
  }

  /** The chart of a completed activity, or null while its job runs. */
  chartFile(activity: bigint) {
    const row = this.activitiesRepository.findActivityFile(activity);
    const fileId = row ? z.number().parse(row.id) : null;

    if (fileId !== null && this.filesRepository.existsSync(this.chartPath(fileId))) return fileId;

    // Imported activities can have a canonical FIT payload without a completion record.
    if (!this.activitiesRepository.fit(activity)?.fit?.length) return null;

    immediate(this.repositories.db, () => {
      const id = fileId ?? Number(this.activitiesRepository.insertActivityFile(activity).lastInsertRowid);
      this.jobsRepository.enqueueOnce('chart', { activityId: Number(activity), fileId: id });
    });

    return null;
  }

  chartPath(fileId: number) {
    return resolve(this.context.config.storageDir, 'activities', String(fileId));
  }

  exportPath(player: number, activity: number, filename: string) {
    const name =
      filename
        .normalize('NFKD')
        .replaceAll(/[^\w. -]/g, '_')
        .replace(/^\.+/, '') || 'activity.fit';

    return resolve(this.context.profiles.folder(player), 'fit', `${activity} - ${name}`);
  }

  /** Write a job result to an attempt-specific path. Only the current claim publishes
  it, and only while its activity exists.
  */
  private async publish(job: RunningJob, path: string, data: string | Uint8Array, exists: () => boolean) {
    const attempt = `${path}.${job.claim.token}.tmp`;
    await this.filesRepository.writeDurableAsync(attempt, data, true);

    const published = job.commit(() => {
      if (exists()) this.filesRepository.renameSync(attempt, path);
    });

    await this.filesRepository.removeAsync(attempt);

    if (published) await this.filesRepository.syncDirectoryAsync(dirname(path));
  }

  registerJobs(jobs: JobsService) {
    jobs.register('power_curve', {
      concurrency: 2,
      attempts: 3,
      timeoutMs: 60_000,
      run: async (job) => {
        const id = job.number('activityId');
        const stored = this.activitiesRepository.fit(id);

        if (!stored?.fit || stored.player === null) return;
        const player = stored.player;
        const curve = await FitService.powerBests(stored.fit);

        job.commit(() => {
          if (!this.activitiesRepository.findActivity(id, player)) return;
          this.fitnessRepository.deleteActivityPowerCurve(id);
          new FitService(this.repositories).insertPowerBests(player, curve, id);
        });
      },
    });

    jobs.register('fit_export', {
      concurrency: 2,
      attempts: 5,
      timeoutMs: 60_000,
      run: async (job) => {
        const id = job.number('activityId');
        const stored = this.activitiesRepository.fit(id);

        if (!stored?.fit || stored.player === null) return;
        const player = stored.player;

        await this.publish(
          job,
          this.exportPath(player, id, stored.filename),
          stored.fit,
          () => !!this.activitiesRepository.findActivity(id, player),
        );
      },
    });

    jobs.register('chart', {
      concurrency: 2,
      attempts: 3,
      timeoutMs: 60_000,
      run: async (job) => {
        const id = job.number('activityId');
        const fileId = job.number('fileId');
        const stored = this.activitiesRepository.fit(id);

        if (!stored?.fit) return;
        const chart = await FitService.chart(stored.fit);

        await this.publish(
          job,
          this.chartPath(fileId),
          JSON.stringify(chart),
          () => !!this.activitiesRepository.findOwnedActivityFile(fileId, id),
        );
      },
    });

    jobs.register('artifact_cleanup', {
      concurrency: 1,
      attempts: 5,
      timeoutMs: 120_000,
      run: async (job) => {
        const activity = job.number('activityId');
        const player = job.number('playerId');
        const folder = this.context.profiles.folder(player);
        const exports = await this.filesRepository.entriesAsync(resolve(folder, 'fit'));

        const paths = [
          ...identifiers(job, 'charts').map((id) => this.chartPath(Number(id))),
          ...identifiers(job, 'images').map((id) => resolve(folder, 'images', `${id}.jpg`)),
          ...identifiers(job, 'media').flatMap((id) => [
            resolve(folder, 'medias', `${id}.mp4`),
            resolve(folder, 'medias', `${id}.mov`),
          ]),
          ...exports
            .filter((entry) => entry.name.startsWith(`${activity} - `))
            .map((entry) => resolve(folder, 'fit', entry.name)),
        ];

        await Promise.all(paths.map((path) => this.filesRepository.removeAsync(path)));
      },
    });

    // Legacy completions finished by the storage migration create their deliveries at
    // runtime, where the operator configuration is known.
    jobs.register('completion_deliveries', {
      concurrency: 1,
      attempts: 3,
      timeoutMs: 30_000,
      run: async (job) => {
        const id = job.number('activityId');
        const saved = this.completionRepository.get(BigInt(id));

        if (!saved) return;
        const providers = new UploadsService(this.context).configured(saved.player_id);

        job.commit(() => {
          for (const provider of providers)
            if (this.uploadsRepository.insert(id, provider))
              this.jobsRepository.enqueue('delivery', { activityId: id, provider });
        });

        await Promise.resolve();
      },
    });
  }
}
