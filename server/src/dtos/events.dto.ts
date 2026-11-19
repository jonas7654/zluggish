import { Schema } from 'effect';

export const notificationPayloadSchema = Schema.Struct({ argString0: Schema.String });

export const notificationEventSchema = Schema.Struct({ eventStartDate: Schema.Finite });

export const notificationUpdateSchema = Schema.Struct({ read: Schema.Boolean, readDate: Schema.NullOr(Schema.String) });
