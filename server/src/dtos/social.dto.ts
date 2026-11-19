import { Schema } from 'effect';
import { withDefault } from '#src/schema';
import { ActivityPrivacy } from '#src/enum';

export const profileSearchSchema = Schema.Struct({ query: Schema.String });

export const privacyUpdateSchema = Schema.Struct({
  approvalRequired: Schema.Boolean,
  displayWeight: Schema.Boolean.pipe(withDefault(false)),
  minor: Schema.Boolean.pipe(withDefault(false)),
  privateMessaging: Schema.Boolean,
  defaultFitnessDataPrivacy: Schema.Boolean,
  suppressFollowerNotification: Schema.Boolean.pipe(withDefault(false)),
  displayAge: Schema.Boolean,
  defaultActivityPrivacy: Schema.Enum(ActivityPrivacy),
});

export const companionConnectionSchema = Schema.Struct({
  phoneAddress: Schema.String.check(Schema.isMaxLength(255)),
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65_535))),
  securePort: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65_535))),
  secret: Schema.optional(Schema.String),
});

export const playbackRecordSchema = Schema.Struct({
  uuid: Schema.String,
  segment_id: Schema.BigInt,
  time: Schema.Finite,
  world_time: Schema.BigInt,
});
