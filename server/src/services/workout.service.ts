import { uuid, metadataSchema, storedEntrySchema, type StoredEntry } from '#src/dtos/workout.dto';
import type { RepositoryContext as Runtime } from '#src/context';
import { UnreadableCredentialsError } from '#src/errors';
import { BaseService } from '#src/services/base.service';
import { SettingsService } from '#src/services/settings.service';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { resolve } from 'node:path';
import { Option, Schema } from 'effect';
import { decodeOwned, withDefault } from '#src/schema';

const isCollection = Schema.is(Schema.Struct({ workouts: Schema.Array(Schema.Json) }));

const decodeStoredEntry = Schema.decodeUnknownOption(storedEntrySchema);

const number = (value: typeof Schema.Json.Type | undefined, fallback = 0) => {
  const result = Number(value);

  return value !== undefined && Number.isFinite(result) && result >= 0 ? result : fallback;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
});

const documentSchema = Schema.Record(Schema.String, Schema.Json);

const stepSchema = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Json]));

const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function parseXML(content: string) {
  if (
    /<!DOCTYPE|<!ENTITY/i.test(content) ||
    Buffer.byteLength(content) > 16 * 1024 * 1024 ||
    XMLValidator.validate(content) !== true
  )
    throw new Error('Invalid workout XML');

  return Schema.decodeUnknownSync(documentSchema)(parser.parse(content));
}

export class WorkoutsService extends BaseService {
  private scheduleID(identity: string) {
    const digest = this.cryptoRepository
      .sha1(Buffer.concat([Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'), Buffer.from(identity)]))
      .subarray(0, 16);

    digest[6] = ((digest[6] ?? 0) & 15) | 80;
    digest[8] = ((digest[8] ?? 0) & 63) | 128;
    const hex = digest.toString('hex');

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Publication is synchronous: capture -> replace -> commit, or restore on exception.
  // This is exception rollback, not a durable crash journal; no published marker is invented.
  private publishFiles(files: ReadonlyMap<string, string | Uint8Array>, commit?: () => void) {
    const previous = new Map<string, Buffer | null>();

    try {
      for (const [file, content] of files) {
        previous.set(file, this.filesRepository.existsSync(file) ? this.filesRepository.readFileSync(file) : null);
        this.filesRepository.writeDurable(file, content, true);
      }

      commit?.();
    } catch (error) {
      for (const [file, content] of previous)
        if (content === null) this.filesRepository.rmSync(file, { force: true });
        else this.filesRepository.writeDurable(file, content, true);
      throw error;
    }
  }

  constructor(readonly runtime: Runtime) {
    super(runtime.accounts.repositories);
  }

  syncWorkoutsAutomatically(id: number, android = false) {
    return WorkoutsService.syncWorkoutsAutomatically(this.runtime, id, android);
  }

  provider(id: number) {
    const settings = SettingsService.resolveRiderSettings(
      this.runtime.config.riderDefaults,
      this.runtime.settings.read(id),
    );

    const available = [];

    if (this.connectionsRepository.has(id, 'intervals')) available.push('intervals-icu');

    if (settings.workouts.trainingpeaks.bridgeFolder) available.push('trainingpeaks');

    const file = resolve(this.runtime.profiles.folder(id), 'active_workout_provider.txt');

    const saved = this.filesRepository.existsSync(file) ? this.filesRepository.readFileSync(file, 'utf8').trim() : '';

    return available.includes(saved) ? saved : (available[0] ?? null);
  }

  entries(id: number) {
    const file = resolve(this.runtime.profiles.folder(id), 'intervals_icu_workout.json');

    if (!this.filesRepository.existsSync(file)) return [];
    const raw = Schema.decodeUnknownSync(documentSchema)(JSON.parse(this.filesRepository.readFileSync(file, 'utf8')));

    return Schema.decodeUnknownSync(Schema.Array(metadataSchema))(Array.isArray(raw.workouts) ? raw.workouts : [raw]);
  }

  metadataFile(id: number) {
    return resolve(this.runtime.profiles.folder(id), 'intervals_icu_workout.json');
  }

  /** Unmodified stored entries, including fields the schema does not read. */
  stored(id: number) {
    const none: StoredEntry[] = [];
    const file = this.metadataFile(id);

    if (!this.filesRepository.existsSync(file)) return { collection: false, entries: none };

    const raw: unknown = JSON.parse(this.filesRepository.readFileSync(file, 'utf8'));

    return isCollection(raw)
      ? {
          collection: true,
          entries: raw.workouts.flatMap((entry) => Option.toArray(decodeStoredEntry(entry))),
        }
      : { collection: false, entries: [Schema.decodeUnknownSync(storedEntrySchema)(raw)] };
  }

  removeEvent(id: number, eventId: string | number) {
    const { entries } = this.stored(id);

    const removed = entries.filter((entry) => String(entry.event_id) === String(eventId));

    if (removed.length === 0) return;

    for (const entry of removed) {
      const file = this.file(entry.workout_id ?? '');

      if (file && this.filesRepository.existsSync(file)) this.filesRepository.rmSync(file);
    }

    const remaining = entries.filter((entry) => !removed.includes(entry));

    this.filesRepository.writeDurable(
      this.metadataFile(id),
      JSON.stringify({
        ...(remaining[0] ?? { provider: 'intervals-icu' }),
        workouts: remaining,
      }),
      true,
    );
  }

  list(id: number, now = new Date()) {
    if (this.provider(id) !== 'intervals-icu') return [];
    const day = localDay(now);
    const seen = new Set<string>();

    return this.entries(id).flatMap((metadata) => {
      const identity = Schema.decodeUnknownOption(uuid)(metadata.workout_id);

      if (Option.isNone(identity) || seen.has(identity.value)) return [];

      const planned =
        metadata.start_date_local?.slice(0, 10) ?? (metadata.start_date ? localDay(new Date(metadata.start_date)) : '');

      if (planned !== day || metadata.provider !== 'intervals-icu') return [];
      const file = this.file(identity.value);

      if (
        !file ||
        !this.filesRepository.existsSync(file) ||
        [file, resolve(file, '..'), resolve(file, '../..')].some((path) =>
          this.filesRepository.lstatSync(path).isSymbolicLink(),
        )
      )
        return [];
      const details = WorkoutsService.workoutDetails(this.filesRepository.readFileSync(file, 'utf8'));

      if (!details) return [];
      seen.add(identity.value);

      const scheduleId = this.scheduleID(`zoffline:schedule:${id}:intervals-icu:${metadata.event_id}:${day}`);

      const uri = `https://cdn.zwift.com/tp-workouts/intervalsicu/${identity.value}.zwo`;
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const tomorrow = new Date(midnight);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const summary = {
        ...details,
        description: metadata.description || details.description,
        name: metadata.name || details.name,
        workoutAssetUrl: uri,
        workoutId: identity.value,
        legacyId: 0,
        sport: 'CYCLING',
        lastCompletion: null,
        stressPoints: metadata.icu_training_load ?? 0,
        primaryTrainingFocus: null,
        secondaryTrainingFocus: null,
      };

      return {
        id: identity.value,
        schedule: {
          scheduleId,
          workoutId: identity.value,
          workoutUri: uri,
          trainingProviderId: 'intervalsicu',
          availableAfter: Math.floor(midnight.getTime() / 1000),
          notAvailableAfter: Math.floor(tomorrow.getTime() / 1000) - 1,
          workoutSummary: summary,
        },
        home: {
          nextUp: {
            selected: {
              entityId: identity.value,
              entityType: 'WORKOUT',
              recommendedDurationMinutes: null,
              tags: [],
              token: 'Component.Card.Activity',
            },
            recommendation: null,
            source: 'SCHEDULED',
            sourceId: scheduleId,
            explanation: null,
            expires: null,
            title: 'LOC_TODAY_LOWER',
            provider: 'intervalsicu',
            providerProperties: null,
            metadata: [],
          },
        },
      };
    });
  }

  file(id: string) {
    return Schema.is(uuid)(id)
      ? resolve(this.runtime.config.storageDir, 'tp-workouts/intervalsicu', `${id}.zwo`)
      : null;
  }

  async sync(id: number, signal = AbortSignal.timeout(30_000)) {
    signal.throwIfAborted();
    const provider = this.provider(id);

    if (provider === 'trainingpeaks') return this.bridge(id, signal);

    if (provider !== 'intervals-icu') return 'Configure a workout provider first.';

    let credentials: readonly [string, string] | null;

    try {
      credentials = this.connectionsRepository.read(id, 'intervals');
    } catch (error) {
      if (!(error instanceof UnreadableCredentialsError)) throw error;
      this.runtime.world.lifecycle.log.warn('connections.unreadable', 'Saved credentials cannot be decrypted', {
        playerId: id,
        provider: 'intervals',
        error,
      });

      return 'The saved Intervals.icu credentials cannot be read. Enter them again in Integrations.';
    }

    if (!credentials) return 'Intervals.icu credentials are missing.';
    const [athlete, key] = credentials;

    if (!/^\d+$/.test(athlete)) throw new Error('Invalid athlete ID');

    const headers = {
      Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`,
    };

    const base = `https://intervals.icu/api/v1/athlete/${athlete}`;
    const today = localDay(new Date());

    const response = await fetch(
      `${base}/events?${new URLSearchParams({ oldest: today, newest: today, category: 'WORKOUT' })}`,
      { headers, signal },
    );

    if (!response.ok) throw new Error('Intervals.icu sync failed');

    const events = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          id: Schema.Union([Schema.Int.check(Schema.isGreaterThan(0)), Schema.String.check(Schema.isPattern(/^\d+$/))]),
          name: Schema.optional(Schema.NullOr(Schema.String)),
          start_date_local: Schema.optional(Schema.String),
          start_date: Schema.optional(Schema.String),
          category: Schema.String.pipe(withDefault('WORKOUT')),
          description: Schema.optional(Schema.NullOr(Schema.String)),
          icu_training_load: Schema.optional(Schema.NullOr(Schema.Finite)),
        }),
      ),
    )(await response.json());

    const selected = events.filter(
      (event) =>
        event.category === 'WORKOUT' &&
        (event.start_date_local?.slice(0, 10) ?? localDay(new Date(event.start_date ?? ''))) === today,
    );

    const downloads = [];

    for (const event of selected) {
      const response = await fetch(`${base}/events/${event.id}/download.zwo`, {
        headers,
        signal,
      });

      if (!response.ok) throw new Error('Intervals.icu download failed');
      const text = await response.text();

      if (!WorkoutsService.workoutDetails(text)) throw new Error('Invalid cycling workout');
      downloads.push({ event, text });
    }

    const previous = this.entries(id);

    const pendingFiles = new Map<string, string>();

    const entries = downloads.map(({ event, text }) => {
      const old = previous.find((item) => String(item.event_id) === String(event.id));

      const identity = Schema.is(uuid)(old?.workout_id)
        ? Schema.decodeUnknownSync(Schema.String)(old?.workout_id)
        : this.cryptoRepository.randomUUID();

      // Preserve interleaved exercise and text-event order while replacing only the root ID.
      const ordered = decodeOwned(Schema.Array(documentSchema))(
        new XMLParser({
          preserveOrder: true,
          ignoreAttributes: false,
          processEntities: true,
          parseTagValue: false,
          parseAttributeValue: false,
        }).parse(text),
      );

      const root = ordered.find((node) => 'workout_file' in node);

      if (!root) throw new Error('Missing workout root');
      const children = Schema.decodeUnknownSync(Schema.Array(documentSchema))(root.workout_file);
      root.workout_file = [...children.filter((node) => !('uniqueId' in node)), { uniqueId: [{ '#text': identity }] }];
      const content = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false }).build(ordered);

      const file = this.file(identity);

      if (!file) throw new Error('Invalid workout identity');
      pendingFiles.set(file, Schema.decodeUnknownSync(Schema.String)(content));

      return {
        ...event,
        provider: 'intervals-icu',
        event_id: event.id,
        workout_id: identity,
        filename: `${identity}.zwo`,
        synced_at: new Date().toISOString(),
      };
    });

    pendingFiles.set(
      this.metadataFile(id),
      JSON.stringify({
        ...(entries[0] ?? { provider: 'intervals-icu' }),
        workouts: entries,
      }),
    );
    pendingFiles.set(resolve(this.runtime.profiles.folder(id), 'active_workout_provider.txt'), 'intervals-icu');
    signal.throwIfAborted();
    // Publication is synchronous: no request can observe new metadata before all files exist.
    this.publishFiles(pendingFiles);

    return `Synced ${entries.length} Intervals.icu workouts.`;
  }

  bridge(id: number, signal = AbortSignal.timeout(30_000)) {
    const settings = SettingsService.resolveRiderSettings(
      this.runtime.config.riderDefaults,
      this.runtime.settings.read(id),
    );

    const folder = settings.workouts.trainingpeaks.bridgeFolder;

    if (!folder || !this.filesRepository.existsSync(folder)) return 'TrainingPeaks bridge folder is missing.';
    const imports: { filename: string; content: Buffer }[] = [];

    for (const name of this.filesRepository.readdirSync(folder).sort()) {
      if (!name.toLowerCase().endsWith('.zwo') || !this.filesRepository.lstatSync(resolve(folder, name)).isFile())
        continue;
      signal.throwIfAborted();
      const content = this.filesRepository.readFileSync(resolve(folder, name));
      parseXML(content.toString('utf8'));

      const filename = `trainingpeaks-${
        name
          .slice(0, -4)
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, '-')
          .replaceAll(/^-|-$/g, '') || 'workout'
      }.zwo`;

      if (imports.some((item) => item.filename === filename)) throw new Error(`Workout filenames collide: ${filename}`);
      imports.push({ filename, content });
    }

    const pendingFiles = new Map<string, string | Uint8Array>();

    for (const item of imports)
      pendingFiles.set(resolve(this.runtime.profiles.folder(id), 'customworkouts', item.filename), item.content);
    pendingFiles.set(resolve(this.runtime.profiles.folder(id), 'active_workout_provider.txt'), 'trainingpeaks');
    signal.throwIfAborted();
    const db = this.runtime.accounts.db;
    const timestamp = Math.floor(Date.now() / 1000);
    db.exec('BEGIN IMMEDIATE');

    try {
      for (const { filename } of imports) {
        const repository = this.storageRepository;
        const old = repository.findZfile(id, 'customworkouts', filename);

        if (old) repository.updateZfileTimestamp(timestamp, old.id);
        else repository.insertZfile(id, 'customworkouts', filename, timestamp);
      }

      this.publishFiles(pendingFiles, () => {
        db.exec('COMMIT');
      });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return `Imported ${imports.length} TrainingPeaks workouts.`;
  }

  static workoutDetails(content: string) {
    const document = parseXML(content);
    const root = Schema.decodeUnknownSync(documentSchema)(document.workout_file);
    const workout = Schema.decodeUnknownSync(documentSchema)(root.workout);

    if (!['bike', 'cycling'].includes(String(root.sportType ?? 'bike').toLowerCase())) return null;
    const zones = [0, 0, 0, 0, 0, 0];
    let duration = 0;
    let known = true;

    function add(seconds: number, low: number, high = low) {
      if (seconds <= 0) return;
      duration += seconds;

      if (low < 0 || high < 0) {
        known = false;

        return;
      }

      const cuts = [0, 1];

      if (low !== high)
        for (const limit of [0.55, 0.75, 0.9, 1.05, 1.2])
          if (Math.min(low, high) < limit && limit < Math.max(low, high)) cuts.push((limit - low) / (high - low));
      cuts.sort((a, b) => a - b);

      for (let index = 1; index < cuts.length; index++) {
        const start = cuts[index - 1] ?? 0;
        const end = cuts[index] ?? 1;
        const power = low + ((high - low) * (start + end)) / 2;

        const zone = [0.55, 0.75, 0.9, 1.05, 1.2].findIndex((limit) => power <= limit);

        const target = zone === -1 ? 5 : zone;
        zones[target] = (zones[target] ?? 0) + seconds * (end - start);
      }
    }

    for (const [tag, value] of Object.entries(workout))
      for (const entry of Array.isArray(value) ? value : [value]) {
        const parsed = Schema.decodeUnknownOption(stepSchema)(entry);

        if (Option.isNone(parsed)) continue;
        const step = parsed.value;

        if (tag === 'IntervalsT') {
          const repeat = number(step['@_Repeat']);

          if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 604_800) return null;
          add(repeat * number(step['@_OnDuration']), number(step['@_OnPower'], -1));
          add(repeat * number(step['@_OffDuration']), number(step['@_OffPower'], -1));
        } else if (['Warmup', 'Cooldown', 'Ramp'].includes(tag))
          add(number(step['@_Duration']), number(step['@_PowerLow'], -1), number(step['@_PowerHigh'], -1));
        else add(number(step['@_Duration']), number(step['@_Power'], -1));
      }

    if (duration <= 0 || duration > 604_800) return null;
    const exact = zones.map((value) => (100 * value) / duration);
    const percentages = known ? exact.map((element) => Math.floor(element)) : [0, 0, 0, 0, 0, 0];

    if (known) {
      const order = exact
        .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
        .sort((a, b) => b.fraction - a.fraction);

      const remaining = 100 - percentages.reduce((sum, value) => sum + value, 0);

      for (const item of order.slice(0, remaining)) percentages[item.index] = (percentages[item.index] ?? 0) + 1;
    }

    return {
      name: String(root.name ?? ''),
      description: String(root.description ?? ''),
      duration: Math.round(duration),
      zonePercentages: percentages,
      difficulty: Math.min(number(root.difficulty), 5),
    };
  }

  static syncWorkoutsAutomatically(runtime: Runtime, id: number, android = false) {
    let provider: string | null;
    const workouts = new WorkoutsService(runtime);

    try {
      provider = workouts.provider(id);
    } catch {
      runtime.world.lifecycle.log.warn('workout.provider_unavailable', 'Automatic workout provider unavailable', {
        playerId: id,
      });

      return Promise.resolve();
    }

    if (!provider || (android && provider !== 'intervals-icu')) return Promise.resolve();
    const requests = pending.get(runtime) ?? new Map<string, { status: 'syncing'; promise: Promise<void> }>();
    pending.set(runtime, requests);
    const key = `${id}:${provider}`;
    const previous = requests.get(key);

    if (previous) return previous.promise;

    const request = workouts
      .sync(id, AbortSignal.timeout(5000))
      .then(() => {})
      .catch((error) => {
        runtime.world.lifecycle.log.warn(
          'workout.sync_failed',
          'Automatic workout sync failed; retaining cached workouts',
          { playerId: id, error: error instanceof Error ? error : String(error) },
        );
      })
      .finally(() => {
        if (requests.get(key)?.promise === request) requests.delete(key);
      });

    requests.set(key, { status: 'syncing', promise: request });

    return request;
  }
}

const pending = new WeakMap<Runtime, Map<string, { status: 'syncing'; promise: Promise<void> }>>();
