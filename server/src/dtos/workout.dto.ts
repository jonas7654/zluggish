import { Schema } from 'effect';

export const uuid = Schema.String.check(Schema.isUUID());

export const metadataSchema = Schema.Struct({
  provider: Schema.String,
  event_id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
  workout_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  start_date_local: Schema.optional(Schema.NullOr(Schema.String)),
  start_date: Schema.optional(Schema.NullOr(Schema.String)),
  icu_training_load: Schema.optional(Schema.NullOr(Schema.Finite)),
});

export const identifier = Schema.Union([Schema.String, Schema.Finite]);

/** Loose on purpose: unread provider fields must survive a rewrite. */
export const storedEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    event_id: Schema.optional(Schema.NullOr(identifier)),
    id: Schema.optional(Schema.NullOr(identifier)),
    workout_id: Schema.optional(Schema.NullOr(Schema.String)),
    name: Schema.optional(Schema.NullOr(Schema.String)),
    start_date_local: Schema.optional(Schema.NullOr(Schema.String)),
    start_date: Schema.optional(Schema.NullOr(Schema.String)),
    synced_for_date: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type StoredEntry = (typeof storedEntrySchema)['Type'];
