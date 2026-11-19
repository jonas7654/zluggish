import { ImportFile as ImportFilename, ImportState } from '#src/enum';
import { Schema } from 'effect';

export const importFilenameSchema = Schema.Enum(ImportFilename);

export type ImportFile = (typeof importFilenameSchema)['Type'];

export type ImportFiles = Partial<Record<ImportFile, Uint8Array>>;

export const filenameSchema = importFilenameSchema;

export const manifestSchema = Schema.Struct({
  playerId: Schema.Int.check(Schema.isGreaterThan(0)),
  authVersion: Schema.Int,
  sourceId: Schema.NullOr(Schema.String),
  firstName: Schema.String,
  lastName: Schema.String,
  files: Schema.Array(filenameSchema),
  before: Schema.Struct({
    firstName: Schema.String,
    lastName: Schema.String,
    officialPlayerId: Schema.NullOr(Schema.String),
  }),
  state: Schema.Enum(ImportState),
});

export type ImportManifest = (typeof manifestSchema)['Type'];
