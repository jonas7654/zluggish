import { Schema } from 'effect';
import { Email } from '#src/schema';

export const climbSchema = Schema.Struct({ name: Schema.String, road: Schema.String });

export const createUserSchema = Schema.Struct({
  email: Email,
  password: Schema.String.check(Schema.isMinLength(1)),
  profile: Schema.Struct({ firstName: Schema.String, lastName: Schema.String }),
});
