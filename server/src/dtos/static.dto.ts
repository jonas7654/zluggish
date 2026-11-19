import { Schema } from 'effect';
import { HttpMethod, ResponseMode } from '#src/enum';

export const staticResponseSchema = Schema.Struct({
  methods: Schema.Array(Schema.Enum(HttpMethod)),
  path: Schema.String,
  body: Schema.Json,
  mode: Schema.Enum(ResponseMode),
  authenticated: Schema.Boolean,
  status: Schema.Union([
    Schema.Literal(200),
    Schema.Literal(201),
    Schema.Literal(202),
    Schema.Literal(204),
    Schema.Literal(400),
    Schema.Literal(404),
    Schema.Literal(500),
  ]),
});
