import { Schema } from 'effect';

export const fileUploadSchema = Schema.Struct({
  folder: Schema.String,
  name: Schema.String,
  content: Schema.String.check(Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
});
