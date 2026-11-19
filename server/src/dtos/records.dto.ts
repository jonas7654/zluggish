import { IsoDateTime } from '#src/schema';
import { Schema } from 'effect';

export const routeCompletionStatsSchema = Schema.Struct({
  route_hash: Schema.Finite,
  first: Schema.NullOr(Schema.Finite),
  last: Schema.NullOr(Schema.Finite),
});

export const meetupStartSchema = Schema.Struct({ eventStart: IsoDateTime });
