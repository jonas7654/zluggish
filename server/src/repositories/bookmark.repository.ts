import { query, SqliteExecutor } from '#src/db/query';
import type { DatabaseSync } from 'node:sqlite';
import { Schema } from 'effect';

const row = Schema.Struct({
  course: Schema.Finite,
  sport: Schema.Finite,
  name: Schema.String,
  state: Schema.instanceOf(Uint8Array),
});

export class BookmarksRepository {
  private readonly executor: SqliteExecutor;

  constructor(db: DatabaseSync) {
    this.executor = new SqliteExecutor(db);
  }

  list(player: number) {
    return this.executor
      .all(
        query
          .selectFrom('bookmark')
          .select(['course', 'sport', 'name', 'state'])
          .where('player_id', '=', player)
          .orderBy('course')
          .orderBy('sport')
          .orderBy('name'),
      )
      .map((found) => Schema.decodeUnknownSync(row)(found));
  }

  save(player: number, course: number, sport: number, name: string, state: Uint8Array) {
    this.executor.run(
      query
        .insertInto('bookmark')
        .values({ player_id: player, course, sport, name, state })
        .onConflict((conflict) => conflict.columns(['player_id', 'course', 'sport', 'name']).doUpdateSet({ state })),
    );
  }
}
