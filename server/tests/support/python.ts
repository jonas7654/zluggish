import { readFileSync } from 'node:fs';
import { Schema } from 'effect';

export const pythonFixtures = Schema.decodeUnknownSync(
  Schema.Struct({
    key: Schema.String,
    payload: Schema.String,
    packets: Schema.Array(Schema.Struct({ flags: Schema.Finite, wire: Schema.String, decrypted: Schema.String })),
    credentialKey: Schema.String,
    credentials: Schema.String,
    password: Schema.String,
    scryptHash: Schema.String,
    sha256Hash: Schema.String,
    profile: Schema.String,
    secret: Schema.String,
    identity: Schema.String,
    cookie: Schema.String,
  }),
)(JSON.parse(readFileSync(new URL('../fixtures/python.json', import.meta.url), 'utf8')));
