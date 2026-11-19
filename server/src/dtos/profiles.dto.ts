import { Schema } from 'effect';

export const profileUpdateSchema = Schema.Struct({
  countryCode: Schema.optional(Schema.Int),
  dob: Schema.optional(Schema.String),
  emailAddress: Schema.optional(Schema.String),
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  male: Schema.optional(Schema.Boolean),
  useMetric: Schema.optional(Schema.Boolean),
  weight: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
