import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const completion = Schema.Struct({
  activity_id: Schema.Finite,
  player_id: Schema.Finite,
  payload: Schema.instanceOf(Uint8Array),
  streak: Schema.NullOr(Schema.instanceOf(Uint8Array)),
  done: Schema.Finite,
});

/** One record per completed activity. The payload is the activity without FIT bytes:
activity.fit holds the canonical payload. A record exists only after the completion
transaction commits.
*/
export class Completions {
  private readonly executor: SqliteExecutor;

  constructor(readonly db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  get(id: bigint) {
    const row = this.executor.get(query.selectFrom('activity_completion').selectAll().where('activity_id', '=', id));

    return row ? Schema.decodeUnknownSync(completion)(row) : null;
  }

  insert(id: bigint, player: number, payload: Uint8Array, streak: Uint8Array | null) {
    this.executor.run(
      query.insertInto('activity_completion').values({ activity_id: id, player_id: player, payload, streak, done: 1 }),
    );
  }
}
