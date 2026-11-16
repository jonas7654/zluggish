import { ConfigError } from '#src/config/index';
import { Repositories } from '#src/repositories';
import type { PasswordActor, Rider } from '#src/repositories/accounts.repository';
import { AccountsRepository } from '#src/repositories/accounts.repository';
import { BaseService } from '#src/services/base.service';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export class AccountsService extends BaseService {
  onRevoke: ((id: number) => void) | undefined;

  readonly db: DatabaseSync;

  readonly repository: AccountsRepository;

  constructor(readonly storage: string) {
    super(new Repositories(storage));
    this.db = this.repositories.db;
    this.repository = this.accountsRepository;
  }

  list() {
    return this.repository.list();
  }

  get(id: number) {
    return this.repository.get(id);
  }

  byUsername(username: string) {
    return this.repository.byUsername(username);
  }

  /** True when another rider already uses this login name after normalization. */
  loginNameTaken(username: string, except?: number) {
    return this.repository.sameLoginName(username).some((rider) => rider.player_id !== except);
  }

  // Setup is one-way: first owner creation commits its marker in the same account transaction.
  identityOf(rider: Rider) {
    return `${rider.player_id}:${rider.auth_version}`;
  }

  identity(identity: string): Rider | null {
    if (!/^\d+:\d+$/.test(identity)) return null;
    const [id = 0, version] = identity.split(':').map(Number);
    const rider = this.get(id);

    return rider && rider.enabled === 1 && rider.pass_hash && rider.auth_version === version ? rider : null;
  }

  /** Direct creation for tests and offline tools. Riders are otherwise created only in the management area. */
  async create(name: string, password: string, username?: string): Promise<Rider> {
    const displayName = name.trim();

    if (!displayName || displayName.length > 100) throw new ConfigError('Enter a name between 1 and 100 characters');

    // Every rider has a password; the launcher can remember it per computer instead.
    if (!password) throw new ConfigError('Choose a password for this rider');
    const passwordHash = await this.cryptoRepository.hashPassword(password);
    let created: string | null = null;
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const occupied = [
        ...this.list().map((user) => user.player_id),
        ...this.filesRepository
          .readdirSync(this.storage)
          .filter((name) => /^\d+$/.test(name))
          .map(Number),
      ];

      // TODO: migrate to uuid before we release the first version
      const id = Math.max(0, ...occupied) + 1;

      if (!Number.isSafeInteger(id) || id > 2_147_483_647) throw new ConfigError('Rider ID space exhausted');
      const folder = resolve(this.storage, String(id));
      this.filesRepository.mkdirSync(folder);
      created = folder;
      const [first = '', ...rest] = displayName.split(/\s+/);
      this.repository.insert({
        player_id: id,
        username: username ?? `rider-${this.cryptoRepository.randomBytes(12).toString('hex')}@local.invalid`,
        first_name: first,
        last_name: rest.join(' '),
        pass_hash: passwordHash,
        auth_version: 1,
        official_player_id: null,
      });

      const user = this.get(id);

      if (!user) throw new Error('Created rider unavailable');

      this.db.exec('COMMIT');

      return user;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');

      if (created) this.filesRepository.rmSync(created, { recursive: true, force: true });

      throw error;
    }
  }

  async verify(rider: Rider, password: string) {
    // Spend the same hashing work as a real check, so timing does not reveal the account state.
    if (!rider.enabled || !rider.pass_hash) {
      await this.cryptoRepository.hashPassword(password);

      return false;
    }

    const valid = await this.cryptoRepository.verifyPassword(rider.pass_hash, password);
    const current = this.get(rider.player_id);

    return !!(
      valid &&
      current?.enabled &&
      current.auth_version === rider.auth_version &&
      current.pass_hash === rider.pass_hash &&
      current.username === rider.username
    );
  }

  async changePassword(
    id: number,
    password: string,
    admin = false,
    live: () => boolean = () => true,
    actor?: PasswordActor,
  ) {
    if (!password) throw new ConfigError('Password must not be empty');
    const before = this.get(id);
    const hash = await this.cryptoRepository.hashPassword(password);
    const current = this.get(id);

    if (
      !live() ||
      !before ||
      !current ||
      current.auth_version !== before.auth_version ||
      current.pass_hash !== before.pass_hash
    )
      throw new ConfigError('Account changed. Retry.');
    this.repository.setPassword(id, hash, admin, actor);
    this.onRevoke?.(id);
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
