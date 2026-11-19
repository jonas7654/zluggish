import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Schema } from 'effect';

const catalogSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    route: Schema.Int,
    course: Schema.Int,
    sport: Schema.Union([Schema.Literal(0), Schema.Literal(1)]),
    distance: Schema.Finite,
  }),
);

export class EventCatalogRepository {
  readEventCatalog(assets: string) {
    return Schema.decodeUnknownSync(catalogSchema)(
      JSON.parse(readFileSync(resolve(assets, 'data/events.txt'), 'utf8')),
    );
  }
}
