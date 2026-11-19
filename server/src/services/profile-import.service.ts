import { filenameSchema, manifestSchema } from '#src/dtos/profile-import.dto';

import type { ImportFile, ImportFiles, ImportManifest } from '#src/dtos/profile-import.dto';

import { EconomyConfigSchema } from '#src/protocol/generated/login_pb';
import { AchievementsSchema, PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { UserStorageSchema } from '#src/protocol/generated/user_storage_pb';
import type { User } from '#src/repositories/accounts.repository';
import type { AccountsService } from '#src/services/auth.service';
import { immediate } from '#src/db/transaction';
import { BaseService } from '#src/services/base.service';
import type { World } from '#src/world/state';
import { clearField, fromBinary, fromJsonString, toBinary } from '@bufbuild/protobuf';
import { resolve } from 'node:path';
import { Schema } from 'effect';

export class ImportsService extends BaseService {
  constructor(
    readonly accounts: AccountsService,
    readonly world: World,
  ) {
    super(accounts.repositories);
  }

  folder(rider: User, stage: string) {
    if (!/^\.ts-import-[a-f0-9]{32}$/.test(stage)) throw new Error('Invalid import ID');

    return resolve(this.accounts.storage, String(rider.player_id), stage);
  }

  prepare(rider: User, files: ImportFiles) {
    if (!this.accounts.identity(this.accounts.identityOf(rider))) throw new Error('Import identity changed');

    if (this.world.active(rider.player_id)) throw new Error('Finish the active ride before importing');
    let profile = null;
    const names: ImportFile[] = [];

    for (const name of Object.values(filenameSchema.enums)) {
      const key = Schema.decodeUnknownSync(filenameSchema)(name);
      const bytes = files[key];

      if (!bytes) continue;

      if (bytes.length > 16 * 1024 * 1024) throw new Error('Invalid import size');

      switch (key) {
        case 'profile.bin': {
          profile = fromBinary(PlayerProfileSchema, bytes);

          if (!profile.id || !profile.firstName.trim()) throw new Error('Profile is missing its ID or name');

          break;
        }

        case 'achievements.bin': {
          toBinary(AchievementsSchema, fromBinary(AchievementsSchema, bytes));

          break;
        }

        case 'user_storage.bin': {
          toBinary(UserStorageSchema, fromBinary(UserStorageSchema, bytes));

          break;
        }

        case 'streaks.bin': {
          toBinary(StreaksSchema, fromBinary(StreaksSchema, bytes));

          break;
        }

        default: {
          if (
            Object.keys(
              Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
                JSON.parse(Buffer.from(bytes).toString()),
              ),
            ).length === 0
          ) {
            throw new Error('Economy configuration is empty');
          }

          toBinary(EconomyConfigSchema, fromJsonString(EconomyConfigSchema, Buffer.from(bytes).toString()));
        }
      }

      names.push(key);
    }

    if (names.length === 0) throw new Error('Select at least one import category');
    const stage = `.ts-import-${this.cryptoRepository.randomBytes(16).toString('hex')}`;
    const folder = this.folder(rider, stage);
    this.filesRepository.mkdirSync(folder, { mode: 0o700 });

    const manifest: ImportManifest = {
      playerId: rider.player_id,
      authVersion: rider.auth_version,
      sourceId: profile?.id.toString() ?? null,
      firstName: profile?.firstName ?? '',
      lastName: profile?.lastName ?? '',
      files: names,
      before: {
        firstName: rider.first_name,
        lastName: rider.last_name,
        officialPlayerId: rider.official_player_id,
      },
      state: 'staged',
    };

    try {
      for (const name of names) {
        const bytes = files[name];

        if (bytes) this.filesRepository.writeDurable(resolve(folder, name), bytes);
      }

      this.filesRepository.writeDurable(resolve(folder, 'manifest.json'), JSON.stringify(manifest));
    } catch (error) {
      this.filesRepository.rmSync(folder, { recursive: true, force: true });
      throw error;
    }

    return stage;
  }

  inspect(rider: User, stage: string) {
    const manifest = Schema.decodeUnknownSync(manifestSchema)(
      JSON.parse(this.filesRepository.readFileSync(resolve(this.folder(rider, stage), 'manifest.json'), 'utf8')),
    );

    if (
      manifest.playerId !== rider.player_id ||
      manifest.authVersion !== rider.auth_version ||
      manifest.state !== 'staged'
    )
      throw new Error('Import identity changed or import already finalized');

    return manifest;
  }

  /** One transaction replaces the rider documents and account names and records the
  stage, so a repeated publication after a crash changes nothing. Replaced documents
  are kept as .bak files in the rider folder.
  */
  publish(rider: User, stage: string, keepName: boolean) {
    if (this.world.active(rider.player_id)) throw new Error('Finish the active ride before importing');

    if (!this.accounts.identity(`${rider.player_id}:${rider.auth_version}`)) throw new Error('Import identity changed');
    const folder = this.folder(rider, stage);
    const manifest = this.inspect(rider, stage);
    const target = resolve(this.accounts.storage, String(rider.player_id));
    const documents = new Map<ImportFile, Uint8Array>();

    for (const name of manifest.files) {
      let bytes: Uint8Array = this.filesRepository.readFileSync(resolve(folder, name));

      if (name === 'profile.bin') {
        const profile = fromBinary(PlayerProfileSchema, bytes);
        profile.id = BigInt(rider.player_id);

        if (profile.socialFacts) profile.socialFacts.profileId = BigInt(rider.player_id);
        clearField(profile, PlayerProfileSchema.field.publicId);
        profile.mixPanelDistinctId = this.cryptoRepository.randomUUID();

        if (keepName) {
          profile.firstName = rider.first_name;
          profile.lastName = rider.last_name;
        }

        bytes = toBinary(PlayerProfileSchema, profile);
      }

      documents.set(name, bytes);
    }

    for (const name of manifest.files) {
      const current = this.riderDocuments.get(rider.player_id, name);

      if (current) this.filesRepository.writeDurable(resolve(target, `${name}.${stage.slice(11)}.bak`), current, true);
    }

    immediate(this.accounts.db, () => {
      if (this.riderDocuments.imported(stage)) return;

      for (const [name, bytes] of documents) this.riderDocuments.put(rider.player_id, name, bytes);

      this.accounts.repository.updateImportedProfile(
        rider.player_id,
        manifest.files.includes('profile.bin') && !keepName ? manifest.firstName : rider.first_name,
        manifest.files.includes('profile.bin') && !keepName ? manifest.lastName : rider.last_name,
        manifest.sourceId ? BigInt(manifest.sourceId) : rider.official_player_id,
      );
      this.riderDocuments.recordImport(stage, rider.player_id);
    });

    this.profileRepository.invalidate(rider.player_id);
    this.filesRepository.rmSync(folder, { recursive: true });
  }

  cancel(rider: User, stage: string) {
    this.inspect(rider, stage);
    this.filesRepository.rmSync(this.folder(rider, stage), { recursive: true });
  }

  /** Remove stages that were published or abandoned before a crash. A staged import
  waits for review; a published stage is never applied twice.
  */
  recover() {
    for (const name of this.filesRepository.readdirSync(this.accounts.storage)) {
      if (!/^\d+$/.test(name)) continue;
      const riderFolder = resolve(this.accounts.storage, name);

      for (const entry of this.filesRepository.readdirSync(riderFolder, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        if (entry.name.startsWith('.import-'))
          throw new Error('Recover the legacy profile import before starting TypeScript');

        if (!/^\.ts-import-[a-f0-9]{32}$/.test(entry.name)) continue;
        const folder = resolve(riderFolder, entry.name);

        // No manifest can exist before preparation finishes.
        if (!this.filesRepository.existsSync(resolve(folder, 'manifest.json'))) {
          this.filesRepository.rmSync(folder, { recursive: true });
          continue;
        }

        const manifest = Schema.decodeUnknownSync(manifestSchema)(
          JSON.parse(this.filesRepository.readFileSync(resolve(folder, 'manifest.json'), 'utf8')),
        );

        if (String(manifest.playerId) !== name) throw new Error('Import journal rider mismatch');

        if (manifest.state !== 'staged' || this.riderDocuments.imported(entry.name))
          this.filesRepository.rmSync(folder, { recursive: true });
      }
    }
  }
}
