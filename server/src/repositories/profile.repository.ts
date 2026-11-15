import type { PlayerProfile } from '#src/protocol/generated/profile_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import type { AccountsRepository } from '#src/repositories/accounts.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class Profiles {
  readonly synthetic = new Map<bigint, PlayerProfile>();

  // Each committed change or external replacement advances the source version.
  // An asynchronous load stores its result only if the version did not change.
  private readonly cache = new Map<number, PlayerProfile>();

  private readonly versions = new Map<number, number>();

  private readonly files = new AssetFiles();

  constructor(
    readonly storage: string,
    private readonly accounts: AccountsRepository,
  ) {}

  folder(id: number) {
    return resolve(this.storage, String(id));
  }

  version(id: number) {
    return this.versions.get(id) ?? 0;
  }

  get(id: number): PlayerProfile {
    const synthetic = this.synthetic.get(BigInt(id));

    if (synthetic) return clone(PlayerProfileSchema, synthetic);
    const cached = this.cache.get(id);

    if (cached) return clone(PlayerProfileSchema, cached);
    const path = resolve(this.folder(id), 'profile.bin');
    const profile = this.decode(id, existsSync(path) ? readFileSync(path) : null);
    this.cache.set(id, profile);

    return clone(PlayerProfileSchema, profile);
  }

  /** Load into the cache without blocking the main thread. */
  async load(id: number): Promise<PlayerProfile> {
    const synthetic = this.synthetic.get(BigInt(id));

    if (synthetic) return clone(PlayerProfileSchema, synthetic);

    for (;;) {
      const cached = this.cache.get(id);

      if (cached) return clone(PlayerProfileSchema, cached);
      const version = this.version(id);

      const bytes = await this.files.readAsync(resolve(this.folder(id), 'profile.bin'));

      // A newer change replaced the source during the read: discard and read again.
      if (this.version(id) !== version) continue;
      const profile = this.decode(id, bytes);
      this.cache.set(id, profile);

      return clone(PlayerProfileSchema, profile);
    }
  }

  private decode(id: number, bytes: Uint8Array | null) {
    if (bytes) {
      const profile = fromBinary(PlayerProfileSchema, bytes);
      profile.id = BigInt(id);

      return profile;
    }

    const user = this.accounts.get(id);

    if (!user) throw new Error('Unknown rider');

    return create(PlayerProfileSchema, {
      id: BigInt(id),
      firstName: user.first_name,
      email: user.username,
      mixPanelDistinctId: new CryptoRepository().randomUUID(),
      lastName: user.last_name,
      isMale: true,
      useMetric: true,
      weightInGrams: 75_000,
      heightInMillimeters: 1800,
      countryCode: 0,
    });
  }

  save(id: number, profile: PlayerProfile) {
    profile.id = BigInt(id);
    new AssetFiles().writeDurable(
      resolve(this.folder(id), 'profile.bin'),
      toBinary(PlayerProfileSchema, profile),
      true,
    );
    this.accounts.updateName(id, profile.firstName, profile.lastName);
    this.invalidate(id);
    this.cache.set(id, clone(PlayerProfileSchema, profile));
  }

  /** Call after any change to the stored profile or account names outside save(). */
  invalidate(id: number) {
    this.versions.set(id, this.version(id) + 1);
    this.cache.delete(id);
  }
}
