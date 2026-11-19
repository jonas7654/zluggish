import type { RepositoryContext } from '#src/context';
import { ApplicationError } from '#src/errors';
import type { Achievements } from '#src/protocol/generated/profile_pb';
import { AchievementsSchema } from '#src/protocol/generated/profile_pb';
import type { UserStorage } from '#src/protocol/generated/user_storage_pb';
import { AttributesSchema, UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import { AchievementService } from '#src/services/achievement.service';
import { BaseService } from '#src/services/base.service';
import { clone, create, fromBinary, isFieldSet, toBinary } from '@bufbuild/protobuf';
import { reflect } from '@bufbuild/protobuf/reflect';
import { resolve } from 'node:path';
import { Option, Schema } from 'effect';
import { withDefault } from '#src/schema';

const fileRow = Schema.Struct({
  id: Schema.Finite,
  player_id: Schema.Finite,
  folder: Schema.String,
  filename: Schema.String,
  timestamp: Schema.Finite,
});

function safeName(value: string) {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new ApplicationError({ status: 400 });

  return value;
}

export class StorageService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  achievements(id: number) {
    return new AchievementService(this.repositories).loadAchievements(this.context, id);
  }

  /** Repeated unlocks are idempotent membership additions, not progression increments. */
  unlock(id: number, incoming: Achievements) {
    const stored = this.riderDocuments.get(id, 'achievements.bin');
    const achievements = stored ? fromBinary(AchievementsSchema, stored) : create(AchievementsSchema);

    for (const achievement of incoming.achievements)
      if (achievements.achievements.every((item) => item.id !== achievement.id))
        achievements.achievements.push(achievement);
    this.riderDocuments.put(id, 'achievements.bin', toBinary(AchievementsSchema, achievements));
  }

  attributes(id: number, requested: Set<number>) {
    const storage = this.userStorage(id);

    const unlockBikes = requested.has(24) && this.context.config.equipment.unlockBikeUpgrades;

    const attributes = storage.attributes.filter((attribute) =>
      AttributesSchema.fields.some(
        (field) => requested.has(field.number) && !(unlockBikes && field.number === 24) && isFieldSet(attribute, field),
      ),
    );

    if (unlockBikes) {
      // A stored attribute can contain both progress and unrelated settings.
      for (let index = 0; index < attributes.length; index++) {
        const attribute = clone(AttributesSchema, attributes[index]!);
        delete attribute.bikeProgress;
        attributes[index] = attribute;
      }

      const dictionary = Schema.decodeUnknownSync(
        Schema.Struct({
          bikeframes: Schema.Record(Schema.String, Schema.String),
          bikeframesextra: Schema.Record(Schema.String, Schema.String).pipe(withDefault({})),
        }),
      )(
        JSON.parse(this.filesRepository.readFileSync(resolve(this.context.assets, 'data/game_dictionary.txt'), 'utf8')),
      );

      const now = BigInt(Date.now());

      for (const signature of new Set([
        ...Object.keys(dictionary.bikeframes),
        ...Object.keys(dictionary.bikeframesextra),
      ]))
        attributes.push(
          create(AttributesSchema, {
            bikeProgress: { signature, level: 5, percentage: 1, lastUpgrade: now, time: now },
          }),
        );
    }

    return create(UserStorageSchema, { attributes });
  }

  saveAttributes(id: number, incoming: UserStorage) {
    const storage = this.userStorage(id);

    for (const attribute of incoming.attributes) {
      const incomingFields = reflect(AttributesSchema, attribute);

      storage.attributes = storage.attributes.filter((old) => {
        const existing = reflect(AttributesSchema, old);

        for (const field of AttributesSchema.fields) {
          if (field.fieldKind !== 'message' || !incomingFields.isSet(field) || !existing.isSet(field)) continue;
          const signature = field.message.fields.find((nested) => nested.name === 'signature');

          if (!signature || existing.get(field).get(signature) === incomingFields.get(field).get(signature))
            existing.clear(field);
        }

        return AttributesSchema.fields.some((field) => existing.isSet(field)) || !!existing.getUnknown()?.length;
      });
      storage.attributes.push(attribute);
    }

    this.riderDocuments.put(id, 'user_storage.bin', toBinary(UserStorageSchema, storage));
  }

  private userStorage(id: number) {
    const stored = this.riderDocuments.get(id, 'user_storage.bin');

    return stored ? fromBinary(UserStorageSchema, stored) : create(UserStorageSchema);
  }

  upload(id: number, upload: { folder: string; filename: string; file: Uint8Array }) {
    const folder = safeName(upload.folder);

    if (folder.startsWith('.')) throw new ApplicationError({ status: 400 });
    const name = safeName(upload.filename);
    this.filesRepository.write(resolve(this.context.profiles.folder(id), folder, name), upload.file);
    const existing = this.storageRepository.findZfile(id, folder, name);
    const timestamp = Math.floor(Date.now() / 1000);

    if (existing)
      this.storageRepository.updateZfileTimestamp(timestamp, Schema.decodeUnknownSync(fileRow)(existing).id);

    const fileId = existing
      ? Schema.decodeUnknownSync(fileRow)(existing).id
      : Number(this.storageRepository.insertZfile(id, folder, name, timestamp).lastInsertRowid);

    return { id: fileId, folder, name, timestamp };
  }

  list(id: number, folder: string) {
    return this.storageRepository.listZfile(id, folder).map((row) => Schema.decodeUnknownSync(fileRow)(row));
  }

  private owned(id: number, fileId: string) {
    const parsed = Schema.decodeUnknownOption(fileRow)(this.storageRepository.findZfileRow(fileId, id));

    if (Option.isNone(parsed)) throw new ApplicationError({ status: 404 });

    return parsed.value;
  }

  delete(id: number, fileId: string) {
    const row = this.owned(id, fileId);
    this.filesRepository.remove(
      resolve(this.context.profiles.folder(id), safeName(row.folder), safeName(row.filename)),
    );
    this.storageRepository.deleteZfile(row.id);
  }

  download(id: number, fileId: string) {
    const row = this.owned(id, fileId);

    const contents = this.filesRepository.read(
      resolve(this.context.profiles.folder(id), safeName(row.folder), safeName(row.filename)),
    );

    if (!contents) throw new ApplicationError({ status: 404 });

    return contents;
  }
}
