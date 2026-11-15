import { JobType } from '#src/enum';
import { query, SqliteExecutor } from '#src/db/query';
import { immediate } from '#src/db/transaction';
import { JobError } from '#src/errors';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/** Payloads hold identifiers only: never credentials or binary data. */
export type JobPayload = Record<string, number | string>;

const payloadSchema = z.record(z.string(), z.union([z.number(), z.string()]));

const jobSchema = z.object({
  id: z.number(),
  type: z.enum(JobType),
  payload_version: z.number(),
  payload: z.string(),
  state: z.string(),
  attempts: z.number(),
  next_run_at: z.number(),
  lease_expires_at: z.number().nullable(),
  claim_token: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.number(),
  finished_at: z.number().nullable(),
});

export type Claim = {
  id: number;
  type: JobType;
  payloadVersion: number;
  payload: JobPayload;
  attempts: number;
  token: string;
};

/** queued -> running (claim token, lease) -> done | queued (retry) | failed.
An expired lease permits a new claim; it does not prove the old handler stopped.
Results commit only while the claim token matches and the lease is valid.
*/
export class JobsRepository {
  private readonly executor: SqliteExecutor;

  /** Called after each enqueue; the runner polls once the transaction commits. */
  notify: () => void = () => {};

  constructor(
    private readonly db: DatabaseSync,
    readonly now: () => number = Date.now,
  ) {
    this.executor = new SqliteExecutor(db);
  }

  /** Call inside the transaction of the change that requires the job. */
  enqueue(type: JobType, payload: JobPayload, delayMs = 0) {
    const now = this.now();

    const id = this.executor.run(
      query.insertInto('job').values({
        type,
        payload: JSON.stringify(payload),
        next_run_at: now + delayMs,
        created_at: now,
      }),
    ).lastInsertRowid;

    this.notify();

    return id;
  }

  /** Skip an identical queued job, for work that more than one change can request. */
  enqueueOnce(type: JobType, payload: JobPayload) {
    const serialized = JSON.stringify(payload);

    const queued = this.executor.get(
      query
        .selectFrom('job')
        .select('id')
        .where('type', '=', type)
        .where('payload', '=', serialized)
        .where('state', 'in', ['queued', 'running']),
    );

    return queued ? queued.id : this.enqueue(type, payload);
  }

  /** Job types with claimable work: one read, no write lock. */
  ready(): Set<JobType> {
    const now = this.now();

    return new Set(
      this.executor
        .all(
          query
            .selectFrom('job')
            .select('type')
            .distinct()
            .where(({ eb, or, and }) =>
              or([
                and([eb('state', '=', 'queued'), eb('next_run_at', '<=', now)]),
                and([eb('state', '=', 'running'), eb('lease_expires_at', '<=', now)]),
              ]),
            ),
        )
        .map((row) => z.enum(JobType).parse(row.type)),
    );
  }

  claim(type: JobType, leaseMs: number): Claim | null {
    const token = new CryptoRepository().randomUUID();

    return immediate(this.db, () => {
      const now = this.now();

      const candidate = this.executor.get(
        query
          .selectFrom('job')
          .select('id')
          .where('type', '=', type)
          .where(({ eb, or, and }) =>
            or([
              and([eb('state', '=', 'queued'), eb('next_run_at', '<=', now)]),
              and([eb('state', '=', 'running'), eb('lease_expires_at', '<=', now)]),
            ]),
          )
          .orderBy('next_run_at')
          .orderBy('id')
          .limit(1),
      );

      if (!candidate) return null;

      this.executor.run(
        query
          .updateTable('job')
          .set({
            state: 'running',
            claim_token: token,
            lease_expires_at: now + leaseMs,
            attempts: sql`attempts + 1`,
          })
          .where('id', '=', candidate.id),
      );

      const job = jobSchema.parse(
        this.executor.get(query.selectFrom('job').selectAll().where('id', '=', candidate.id)),
      );

      return {
        id: job.id,
        type: job.type,
        payloadVersion: job.payload_version,
        payload: payloadSchema.parse(JSON.parse(job.payload)),
        attempts: job.attempts,
        token,
      };
    });
  }

  private current(claim: Claim) {
    return query
      .updateTable('job')
      .where('id', '=', claim.id)
      .where('claim_token', '=', claim.token)
      .where('state', '=', 'running')
      .where('lease_expires_at', '>', this.now());
  }

  /** True while this claim still owns the job. */
  valid(claim: Claim) {
    return !!this.executor.get(
      query
        .selectFrom('job')
        .select('id')
        .where('id', '=', claim.id)
        .where('claim_token', '=', claim.token)
        .where('state', '=', 'running')
        .where('lease_expires_at', '>', this.now()),
    );
  }

  renew(claim: Claim, leaseMs: number) {
    return this.executor.run(this.current(claim).set({ lease_expires_at: this.now() + leaseMs })).changes !== 0;
  }

  /** Commit the handler's result and finish the job in one transaction, only while
  the claim is current. Returns false, and changes nothing, for a stale claim.
  */
  finish(claim: Claim, commit: () => void = () => {}) {
    return immediate(this.db, () => {
      if (!this.valid(claim)) return false;
      commit();
      this.executor.run(
        this.current(claim).set({ state: 'done', finished_at: this.now(), lease_expires_at: null, last_error: null }),
      );

      return true;
    });
  }

  retry(claim: Claim, error: string, delayMs: number) {
    return (
      this.executor.run(
        this.current(claim).set({
          state: 'queued',
          next_run_at: this.now() + delayMs,
          lease_expires_at: null,
          claim_token: null,
          last_error: error,
        }),
      ).changes !== 0
    );
  }

  fail(claim: Claim, error: string) {
    return (
      this.executor.run(
        this.current(claim).set({
          state: 'failed',
          finished_at: this.now(),
          lease_expires_at: null,
          last_error: error,
        }),
      ).changes !== 0
    );
  }

  prunable(before: number) {
    return this.executor.all(
      query.selectFrom('job').select('id').where('state', 'in', ['done', 'failed']).where('finished_at', '<', before),
    ).length;
  }

  /** Remove finished jobs older than the retention period. Delivery records stay. */
  prune(before: number) {
    return this.executor.run(
      query.deleteFrom('job').where('state', 'in', ['done', 'failed']).where('finished_at', '<', before),
    ).changes;
  }

  list(type?: JobType) {
    let selection = query.selectFrom('job').selectAll().orderBy('id');

    if (type) selection = selection.where('type', '=', type);

    return this.executor.all(selection).map((job) => jobSchema.parse(job));
  }

  pending(type: JobType) {
    return this.executor.all(
      query.selectFrom('job').select('id').where('type', '=', type).where('state', 'in', ['queued', 'running']),
    ).length;
  }
}

export class RunningJob {
  private finished = false;

  constructor(
    readonly claim: Claim,
    readonly signal: AbortSignal,
    private readonly owner: JobsRepository,
  ) {}

  get payload(): JobPayload {
    return this.claim.payload;
  }

  number(key: string) {
    const value = this.claim.payload[key];

    if (!Number.isSafeInteger(value)) throw new JobError('invalid_payload', false);

    return Number(value);
  }

  text(key: string) {
    const value = this.claim.payload[key];

    if (value === undefined) throw new JobError('invalid_payload', false);

    return String(value);
  }

  /** True while this claim still owns the job. */
  valid() {
    return this.owner.valid(this.claim);
  }

  /** Commit the result and finish the job in one transaction. A stale claim commits
  nothing and returns false.
  */
  commit(result: () => void = () => {}) {
    const committed = this.owner.finish(this.claim, result);
    this.finished = true;

    return committed;
  }

  get done() {
    return this.finished;
  }
}
