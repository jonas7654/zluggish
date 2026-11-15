import type { RepositoryContext } from '#src/context';
import type { PlayerState } from '#src/protocol/generated/udp-node-msgs_pb';
import { RideRecoveryRepository } from '#src/repositories/ride-recovery.repository';
import { BaseService } from '#src/services/base.service';
import { course } from '#src/world/state';

/** Server-side recovery of unfinished rides. Every checkpoint appends the ride history
samples recorded since the previous one; no row is written for each packet. A new
session within the resume window, on the same course, gets the recorded history back.
A ride is never completed or uploaded because its connection ends.
*/
export class RideRecoveryService extends BaseService {
  private timer: NodeJS.Timeout | null = null;

  private readonly written = new Map<bigint, bigint>();

  // `before` is the online state at login: the merge waits for a newer one.
  private readonly pending = new Map<
    bigint,
    { states: PlayerState[]; generation: number; before: PlayerState | undefined }
  >();

  readonly recordings: RideRecoveryRepository;

  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
    this.recordings = new RideRecoveryRepository(context.config.storageDir, context.config.recovery.maxBytes);
  }

  start() {
    this.context.world.sessions = {
      login: (id) => {
        void this.resume(id);
      },
      logout: (id, reason) => {
        // A lost connection can come back within the resume window; other ends cannot.
        if (reason !== 'inactivity_timeout') this.discard(id);
      },
    };

    if (this.timer) return;
    this.timer = setInterval(() => void this.checkpoint(), this.context.config.recovery.checkpointSeconds * 1000);
    this.timer.unref();
  }

  /** Append the history samples recorded since the last checkpoint. */
  async checkpoint() {
    this.merge();
    const appends = [];

    for (const [id, history] of this.context.world.histories) {
      const last = this.written.get(id) ?? -1n;
      const fresh = history.filter((state) => state.worldTime > last);
      const newest = fresh.at(-1);

      if (!newest) continue;
      this.written.set(id, newest.worldTime);
      appends.push(
        this.recordings.append(Number(id), fresh).catch(() => {
          this.context.world.lifecycle.log.warn('ride.recovery_failed', 'Ride recovery checkpoint failed', {
            playerId: id,
          });
        }),
      );
    }

    await Promise.all(appends);
  }

  /** A new session: keep a recent recording for the first state, discard an old one. */
  resume(id: bigint) {
    this.written.delete(id);
    this.pending.delete(id);
    const generation = this.context.world.generation(id);
    const before = this.context.world.online.get(id);

    return this.recordings
      .read(Number(id))
      .then(async (found) => {
        if (!found || this.context.world.generation(id) !== generation) return;
        const expired = Date.now() - found.modified > this.context.config.recovery.resumeMinutes * 60_000;

        if (expired || found.states.length === 0) {
          await this.recordings.remove(Number(id));

          return;
        }

        this.pending.set(id, { states: found.states, generation, before });
        this.merge();
      })
      .catch(() => {
        this.context.world.lifecycle.log.warn('ride.recovery_failed', 'Ride recovery could not be read', {
          playerId: id,
        });
      });
  }

  /** Prepend recovered samples once the session's first state shows the same course. */
  private merge() {
    const world = this.context.world;

    for (const [id, pending] of this.pending) {
      if (world.generation(id) !== pending.generation) {
        this.pending.delete(id);
        continue;
      }

      const online = world.online.get(id);

      // The state from before the login belongs to the previous session.
      if (!online || online === pending.before) continue;
      this.pending.delete(id);
      const last = pending.states.at(-1);

      if (!last || course(last) !== course(online)) {
        void this.recordings.remove(Number(id));
        continue;
      }

      const current = world.histories.get(id) ?? [];
      const first = current[0]?.worldTime;
      const earlier = pending.states.filter((state) => first === undefined || state.worldTime < first);
      world.histories.set(id, [...earlier, ...current].slice(-14_400));
      const newest = earlier.at(-1);

      if (newest) this.written.set(id, newest.worldTime);
      world.lifecycle.log.info('ride.recovered', 'Ride history recovered', { playerId: id, samples: earlier.length });
    }
  }

  discard(id: bigint) {
    this.pending.delete(id);
    this.written.delete(id);
    void this.recordings.remove(Number(id));
  }

  /** A last checkpoint at shutdown: a restart can resume every ride in progress. */
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.checkpoint();
    await this.recordings.idle();
  }
}
