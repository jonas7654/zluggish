import { Schema } from 'effect';

export const eventFeedSchema = Schema.Struct({ data: Schema.Array(Schema.Struct({ event: Schema.Json })) });
