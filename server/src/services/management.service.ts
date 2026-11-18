import { resolve } from 'node:path';
import { configSchema } from '#src/config/schema';
import { EventsService } from '#src/services/events.service';
import { storedSchema, inputSchema as meetupInput } from '#src/dtos/meetup.dto';
import {
  eventRequest,
  worldRequest,
  editUserRequest,
  ownProfileRequest,
  settingsRequest,
  newUser,
  setupRequest,
  mutationRequest,
  serverRequest,
} from '#src/dtos/management.dto';
import { UploadsService } from '#src/services/uploads.service';
import type { JsonValue } from '#src/dtos/management.dto';
import { z } from 'zod';
import type { RideCompletionService } from '#src/services/ride-completion.service';
import type { RepositoryContext } from '#src/context';
import type { User } from '#src/repositories/accounts.repository';
import { ManagementRepository } from '#src/repositories/management.repository';
import { ApplicationError } from '#src/errors';
import { BaseService } from '#src/services/base.service';
import { WebSessionsService } from '#src/services/web-session.service';

export class ManagementService extends BaseService {
  readonly store: ManagementRepository;

  readonly sessions: WebSessionsService;

  private setupDigest: Buffer | null = null;

  private passwordWork = 0;

  constructor(
    private readonly context: RepositoryContext,
    private readonly completion: RideCompletionService,
  ) {
    super(context.accounts.repositories);
    this.store = new ManagementRepository(context.accounts.db);
    this.sessions = new WebSessionsService(context.accounts);
  }

  publicUser(user: User) {
    const { pass_hash, auth_version: _authVersion, ...safe } = user;

    return {
      ...safe,
      has_password: !!pass_hash,
      connected: this.context.world.active(user.player_id),
      avatar: this.avatarVersion(user.player_id),
    };
  }

  issueSetupKey() {
    if (this.store.complete()) return null;
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const bits = [...this.cryptoRepository.randomBytes(32)].map((v) => v.toString(2).padStart(8, '0')).join('');
    let key = '';

    for (let i = 0; i < bits.length; i += 5) key += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    this.setupDigest = Buffer.from(this.cryptoRepository.sha256(key), 'hex');

    return key.match(/.{1,4}/g)!.join('-');
  }

  private keyValid(key: string) {
    const digest = Buffer.from(this.cryptoRepository.sha256(key.toUpperCase().replaceAll(/[-\s]/g, '')), 'hex');

    return this.setupDigest !== null && this.cryptoRepository.timingSafeEqual(digest, this.setupDigest);
  }

  /** Lets the setup form check the key before asking for account details. */
  checkSetupKey(key: string) {
    if (this.store.complete() || !this.keyValid(key))
      throw new ApplicationError({ status: 403, message: 'Setup refused.' });
  }

  async passwordTask<T>(work: () => Promise<T>) {
    if (this.passwordWork >= 4) throw new ApplicationError({ status: 503, message: 'Try again shortly.' });
    this.passwordWork++;

    try {
      return await work();
    } finally {
      this.passwordWork--;
    }
  }

  private insert(input: z.infer<typeof newUser>, hash: string) {
    if (this.context.accounts.loginNameTaken(input.username))
      throw new ApplicationError({ status: 409, message: 'Login name already exists.' });

    const occupied = [
      ...this.context.accounts.list().map((r) => r.player_id),
      ...this.filesRepository
        .readdirSync(this.context.accounts.storage)
        .filter((v) => /^\d+$/.test(v))
        .map(Number),
    ];

    const id = Math.max(0, ...occupied) + 1;

    if (!Number.isSafeInteger(id) || id > 2_147_483_647)
      throw new ApplicationError({ status: 409, message: 'User ID space exhausted.' });
    this.accountsRepository.insert({
      player_id: id,
      username: input.username,
      first_name: input.first_name,
      last_name: input.last_name,
      pass_hash: hash,
    });

    return this.context.accounts.get(id)!;
  }

  async setup(raw: z.input<typeof setupRequest>, live: () => boolean = () => true) {
    const input = setupRequest.parse(raw);

    if (this.store.complete() || !this.keyValid(input.key))
      throw new ApplicationError({ status: 403, message: 'Setup refused.' });

    const existing =
      input.mode === 'existing'
        ? 'player_id' in input
          ? this.context.accounts.get(input.player_id)
          : this.context.accounts.byUsername(input.username)
        : null;

    if (input.mode === 'existing' && existing && !existing.pass_hash)
      throw new ApplicationError({
        status: 400,
        message: 'This user has no password. Create a new user, or set a password with the CLI.',
      });

    const hash = await this.passwordTask(async () => {
      if (input.mode === 'new') return this.cryptoRepository.hashPassword(input.password);

      if (!existing || !(await this.context.accounts.verify(existing, input.password)))
        throw new ApplicationError({ status: 403, message: 'Setup refused.' });

      return null;
    });

    const user = this.store.transaction(() => {
      if (!live() || this.store.complete() || !this.keyValid(input.key))
        throw new ApplicationError({ status: 409, message: 'Setup refused.' });
      let target: User;

      if (input.mode === 'new') target = this.insert(input, hash!);
      else {
        const current = existing && this.context.accounts.get(existing.player_id);

        if (
          !current ||
          !current.enabled ||
          current.auth_version !== existing!.auth_version ||
          current.pass_hash !== existing!.pass_hash ||
          current.username !== existing!.username
        )
          throw new ApplicationError({ status: 409, message: 'Account changed. Retry.' });
        target = current;
      }

      this.store.update(target.player_id, { role: 'administrator' });
      this.store.finish();
      const after = this.context.accounts.get(target.player_id)!;

      return after;
    });

    this.setupDigest = null;

    return user;
  }

  async signIn(username: string, password: string) {
    const user = this.context.accounts.byUsername(username);

    const valid = await this.passwordTask(() =>
      user
        ? this.context.accounts.verify(user, password)
        : this.cryptoRepository.hashPassword(password).then(() => false),
    );

    const current = user && this.context.accounts.get(user.player_id);

    if (
      !user ||
      !valid ||
      !current?.enabled ||
      current.auth_version !== user.auth_version ||
      current.pass_hash !== user.pass_hash ||
      current.username !== user.username
    )
      throw new ApplicationError({ status: 401, message: 'Login name or password is incorrect.' });

    return user;
  }

  async confirm(id: string, password: string) {
    const user = this.sessions.require(id, true, false);
    const identity = this.context.accounts.identityOf(user);

    if (
      !(await this.passwordTask(() => this.context.accounts.verify(user, password))) ||
      !this.sessions.current(id, identity)
    )
      throw new ApplicationError({ status: 401, message: 'Confirmation refused.' });
    this.sessions.require(id, true, false);
    this.sessions.sessions.get(id)!.confirmedUntil = Date.now() + 900_000;
  }

  /** Administrators can already set any password, so they skip the current one. */
  async changeOwnPassword(id: string, current: string | undefined, password: string) {
    const user = this.sessions.require(id);
    const identity = this.context.accounts.identityOf(user);

    const hash = await this.passwordTask(async () => {
      if (user.role !== 'administrator' && !(await this.context.accounts.verify(user, current ?? '')))
        throw new ApplicationError({ status: 403, message: 'Password incorrect.' });

      return this.cryptoRepository.hashPassword(password);
    });

    this.store.transaction(() => {
      if (!this.sessions.current(id, identity))
        throw new ApplicationError({ status: 401, message: 'Session changed.' });
      this.store.update(user.player_id, { pass_hash: hash });
    });
    this.completion.cancel(user.player_id);
  }

  private fingerprint(value: JsonValue) {
    const signed = this.cryptoRepository.signIdentity(JSON.stringify(value), this.context.sessions.secret);

    return signed.slice(signed.lastIndexOf('|') + 1);
  }

  async create(id: string, raw: z.input<typeof newUser>, operation: string) {
    const input = newUser.parse(raw);
    this.sessions.require(id, true);
    const hash = await this.passwordTask(() => this.cryptoRepository.hashPassword(input.password));

    return this.store.transaction(() => {
      const actor = this.sessions.require(id, true);
      const fingerprint = this.fingerprint(input);
      const prior = this.store.operation(actor.player_id, operation);

      if (prior) {
        if (prior.action !== 'create' || prior.fingerprint !== fingerprint)
          throw new ApplicationError({ status: 409, message: 'Operation changed.' });

        return JSON.parse(prior.result!);
      }

      const user = this.insert(input, hash);
      const result = this.publicUser(user);
      this.store.record(actor.player_id, operation, 'create', user.player_id, fingerprint, result);

      return result;
    });
  }

  async mutate(id: string, targetId: number, action: string, raw: z.input<typeof mutationRequest>) {
    const input = mutationRequest.parse(raw);
    this.sessions.require(id, true);

    const hash =
      action === 'password' && input.password
        ? await this.passwordTask(() => this.cryptoRepository.hashPassword(input.password!))
        : undefined;

    let permission: ReturnType<RideCompletionService['capture']> = null;
    let committed = false;

    const result = this.store.transaction(() => {
      const actor = this.sessions.require(id, true);

      if (actor.player_id === targetId && action === 'password')
        throw new ApplicationError({ status: 403, message: 'Change your own password on your profile.' });
      const target = this.context.accounts.get(targetId);

      if (!target) throw new ApplicationError({ status: 404, message: 'User not found.' });
      const fingerprint = this.fingerprint({ action, targetId, input });
      const prior = this.store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new ApplicationError({ status: 409, message: 'Operation changed.' });

        return JSON.parse(prior.result!);
      }

      if (target.revision !== input.revision)
        throw new ApplicationError({ status: 409, message: 'User changed. Review the new data.' });

      if (
        target.enabled &&
        target.role === 'administrator' &&
        (action === 'disable' || (action === 'role' && input.role === 'rider')) &&
        this.store.administrators() <= 1
      )
        throw new ApplicationError({ status: 409, message: 'Keep at least one enabled administrator.' });

      if (action === 'disable') permission = this.completion.capture(targetId);

      const values =
        action === 'password' && hash
          ? { pass_hash: hash }
          : action === 'role' && input.role
            ? { role: input.role }
            : action === 'disable'
              ? { enabled: 0 }
              : action === 'enable'
                ? { enabled: 1 }
                : action === 'revoke-sessions'
                  ? {}
                  : null;

      if (!values) throw new ApplicationError({ status: 400, message: 'Invalid action.' });
      this.store.update(targetId, values);
      committed = true;

      const after = {
        ...this.publicUser(this.context.accounts.get(targetId)!),
        completion_deadline: permission?.deadline ?? null,
      };

      this.store.record(actor.player_id, input.operation, action, targetId, fingerprint, after);

      return after;
    });

    if (committed) {
      if (action === 'disable') this.completion.grant(targetId, permission);
      else this.completion.cancel(targetId);
    }

    return result;
  }

  edit(id: string, player: number, raw: z.input<typeof editUserRequest>) {
    const input = editUserRequest.parse(raw);

    return this.store.transaction(() => {
      const actor = this.sessions.require(id, true);
      const target = this.context.accounts.get(player);

      if (!target) throw new ApplicationError({ status: 404, message: 'User not found.' });
      const fingerprint = this.fingerprint(input);
      const prior = this.store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.action !== 'edit')
          throw new ApplicationError({ status: 409, message: 'Operation changed.' });

        return JSON.parse(prior.result!);
      }

      if (this.context.world.active(player))
        throw new ApplicationError({ status: 409, message: 'Disconnect the user before changing names.' });

      if (target.revision !== input.revision)
        throw new ApplicationError({ status: 409, message: 'User changed. Review the new data.' });

      if (this.context.accounts.loginNameTaken(input.username, player))
        throw new ApplicationError({ status: 409, message: 'Login name already exists.' });

      const profile = this.context.profiles.get(player);
      profile.firstName = input.first_name;
      profile.lastName = input.last_name;
      profile.email = input.username;
      this.context.profiles.save(player, profile);
      this.store.update(player, { username: input.username }, false);
      const result = this.publicUser(this.context.accounts.get(player)!);
      this.store.record(actor.player_id, input.operation, 'edit', player, fingerprint, result);

      return result;
    });
  }

  ownProfile(id: string, player?: number) {
    const actor = this.sessions.require(id, player !== undefined);
    const user = player === undefined ? actor : this.context.accounts.get(player);

    if (!user) throw new ApplicationError({ status: 404, message: 'User not found.' });
    const [month, day, year] = this.context.profiles.get(user.player_id).dob.split('/', 3);

    return {
      user: this.publicUser(this.context.accounts.get(user.player_id)!),
      birthday: year && month && day ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : '',
      avatar: this.avatarVersion(user.player_id),
    };
  }

  /** The game and the Companion app read the same file. */
  avatarPath(player: number) {
    return resolve(this.context.profiles.folder(player), 'avatarLarge.jpg');
  }

  /** Changes with each upload, so the browser does not show a cached photo. */
  avatarVersion(player: number) {
    const path = this.avatarPath(player);

    return this.filesRepository.existsSync(path) ? Math.trunc(this.filesRepository.statSync(path).mtimeMs) : null;
  }

  saveAvatar(id: string, image: Uint8Array, player?: number) {
    const actor = this.sessions.require(id, player !== undefined);
    const user = player === undefined ? actor : this.context.accounts.get(player);

    if (!user) throw new ApplicationError({ status: 404, message: 'User not found.' });

    if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9)
      throw new ApplicationError({ status: 400, message: 'Choose a JPG or PNG image.' });
    this.filesRepository.write(this.avatarPath(user.player_id), image);

    return { avatar: this.avatarVersion(user.player_id) };
  }

  removeAvatar(id: string, player?: number) {
    const actor = this.sessions.require(id, player !== undefined);
    const user = player === undefined ? actor : this.context.accounts.get(player);

    if (!user) throw new ApplicationError({ status: 404, message: 'User not found.' });
    const path = this.avatarPath(user.player_id);

    if (this.filesRepository.existsSync(path)) this.filesRepository.unlinkSync(path);

    return { avatar: null };
  }

  editOwnProfile(id: string, raw: z.input<typeof ownProfileRequest>, targetPlayer?: number) {
    const input = ownProfileRequest.parse(raw);

    return this.store.transaction(() => {
      const actor = this.sessions.require(id, targetPlayer !== undefined);
      const player = targetPlayer ?? actor.player_id;
      const target = this.context.accounts.get(player);

      if (!target) throw new ApplicationError({ status: 404, message: 'User not found.' });
      const fingerprint = this.fingerprint({ ...input, player });
      const prior = this.store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.action !== 'profile')
          throw new ApplicationError({ status: 409, message: 'Operation changed.' });

        return JSON.parse(prior.result!);
      }

      if (this.context.world.active(player))
        throw new ApplicationError({ status: 409, message: 'Leave the game before changing your profile.' });

      if (target.revision !== input.revision)
        throw new ApplicationError({ status: 409, message: 'Profile changed. Reload the page.' });

      if (this.context.accounts.loginNameTaken(input.username, player))
        throw new ApplicationError({ status: 409, message: 'Email address already in use.' });

      const profile = this.context.profiles.get(player);
      profile.firstName = input.first_name;
      profile.lastName = input.last_name;
      profile.email = input.username;
      profile.dob = input.birthday.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1');
      this.context.profiles.save(player, profile);
      this.store.update(player, { username: input.username }, false);
      const result = this.ownProfile(id, targetPlayer);
      this.store.record(actor.player_id, input.operation, 'profile', player, fingerprint, result);

      return result;
    });
  }

  settings(player: number) {
    return {
      revision: this.context.settings.revision(player),
      overrides: this.context.settings.read(player),
      defaults: this.context.config.riderDefaults,
    };
  }

  saveSettings(id: string, player: number, raw: z.input<typeof settingsRequest>, manage = false) {
    const input = settingsRequest.parse(raw);

    return this.store.transaction(() => {
      const actor = this.sessions.require(id, manage);

      if ((manage && actor.player_id === player) || (!manage && actor.player_id !== player))
        throw new ApplicationError({ status: 403, message: 'Own settings only.' });

      if (!this.context.accounts.get(player)) throw new ApplicationError({ status: 404, message: 'User not found.' });
      const fingerprint = this.fingerprint({ player, input });
      const prior = this.store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.action !== 'settings' || prior.fingerprint !== fingerprint)
          throw new ApplicationError({ status: 409, message: 'Operation changed.' });

        return JSON.parse(prior.result!);
      }

      this.context.settings.save(player, input.overrides, input.revision);
      new UploadsService(this.context).revoke(player);
      const after = this.settings(player);
      this.store.record(actor.player_id, input.operation, 'settings', player, fingerprint, after);

      return after;
    });
  }

  async serverOperation(
    id: string,
    action: string,
    raw: z.input<typeof serverRequest>,
    flush: () => Promise<void>,
    dispatch: { reload: () => Promise<void>; bots: (user: number, command: string) => string },
  ) {
    const input = serverRequest.parse(raw);

    if (action === 'bots' && (!input.user || !input.command))
      throw new ApplicationError({ status: 400, message: 'Choose a user and a bot command.' });
    const fingerprint = this.fingerprint({ action, input });

    // The retry check and the intent share one transaction, so a duplicate request never dispatches twice.
    const { actor, prior } = this.store.transaction(() => {
      const actor = this.sessions.require(id, true);
      const prior = this.store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.action !== action || prior.fingerprint !== fingerprint)
          throw new ApplicationError({ status: 409, message: 'Operation changed.' });

        return { actor, prior };
      }

      if (action === 'bots' && !this.context.world.active(input.user!))
        throw new ApplicationError({ status: 409, message: 'The user must be riding now.' });
      this.store.intent(actor.player_id, input.operation, action, fingerprint);

      return { actor, prior: null };
    });

    if (prior) return this.outcome(prior.status, prior.result ? JSON.parse(prior.result) : null);
    await flush();
    let result: JsonValue;

    try {
      this.sessions.require(id, true);
    } catch (error) {
      // A known result: the operation did not run. A retry returns it and never dispatches.
      this.store.finishOperation(actor.player_id, input.operation, {
        error: 'The operation did not run. Confirm your password and start it again.',
      });

      throw error;
    }

    try {
      switch (action) {
        case 'reload-bots': {
          await dispatch.reload();
          result = true;
          break;
        }

        case 'bots': {
          result = dispatch.bots(input.user!, [input.command, input.argument].filter(Boolean).join(' '));
          break;
        }

        default: {
          throw new ApplicationError({ status: 400, message: 'Unknown server operation.' });
        }
      }
    } catch {
      result = { error: 'Operation failed.' };
    }

    this.store.finishOperation(actor.player_id, input.operation, result);

    return this.outcome('complete', result);
  }

  /** The browser gets a parsed outcome: a failure message, a bot reply, or plain success. */
  private outcome(status: string, result: JsonValue) {
    if (status !== 'complete')
      return { status, ok: false, message: 'The result is unknown. Check the server log before you start it again.' };
    const failure = z.object({ error: z.string() }).safeParse(result);

    if (failure.success) return { status, ok: false, message: failure.data.error };
    const reply = z.string().safeParse(result);

    return { status, ok: true, message: reply.success ? reply.data : result === false ? 'Nothing to change.' : null };
  }

  /** Operator configuration as read-only rows. The browser never receives secrets: paths only. */
  configuration(value: JsonValue, prefix = ''): [string, string][] {
    const object = z.record(z.string(), z.json()).safeParse(value);

    if (object.success && !Array.isArray(value))
      return Object.entries(object.data).flatMap(([key, item]) =>
        this.configuration(item, prefix ? `${prefix}.${key}` : key),
      );

    const list = z.array(z.json()).safeParse(value);

    return [[prefix, list.success ? list.data.join(', ') : String(value ?? '')]];
  }

  events() {
    return this.eventsRepository.listPrivateEvent().map((row) => storedSchema.parse(JSON.parse(row.json)));
  }

  editEvent(session: string, eventId: number, action: string, raw: z.input<typeof eventRequest>) {
    const input = eventRequest.parse(raw);
    const actor = this.sessions.require(session, true);
    const fingerprint = this.fingerprint({ eventId, action, input });
    const prior = this.store.operation(actor.player_id, input.operation);

    if (prior) {
      if (prior.action !== action || prior.fingerprint !== fingerprint)
        throw new ApplicationError({ status: 409, message: 'Operation changed.' });

      return JSON.parse(prior.result!);
    }

    const events = new EventsService(this.context);
    const event = events.read(String(eventId));

    if (event.updateDate !== input.revision)
      throw new ApplicationError({ status: 409, message: 'Event changed. Reload and review.' });
    const result = { id: eventId, action };

    const commit = () => {
      this.sessions.require(session, true);
      this.store.record(actor.player_id, input.operation, action, eventId, fingerprint, result);
    };

    if (action === 'delete-event') events.deleteMeetup(event, commit);
    else events.updateMeetup(event, meetupInput.parse({ ...event, ...input.changes }), commit);

    return result;
  }

  worldSettings() {
    const keys = new Set([
      ...this.context.settings.worldIds(),
      ...this.context.config.pelotons.map((value) => `peloton:${value.id}`),
    ]);

    return [...keys].map((id) => {
      const overrides = this.context.settings.world(id);

      const effective = id.startsWith('peloton:')
        ? { ...this.context.config.pelotons.find((value) => value.id === id.slice(8)), ...overrides }
        : { ...this.context.config.soloBlob, ...overrides };

      type WorldField = { name: string; kind: 'boolean' | 'number' | 'string'; value: boolean | number | string };

      const fields: WorldField[] = [];

      for (const [name, value] of Object.entries(effective)) {
        const boolean = z.boolean().safeParse(value);
        const number = z.number().safeParse(value);
        const text = z.string().safeParse(value);

        if (boolean.success) fields.push({ name, kind: 'boolean', value: boolean.data });
        else if (number.success) fields.push({ name, kind: 'number', value: number.data });
        else if (text.success) fields.push({ name, kind: 'string', value: text.data });
      }

      return { id, revision: this.context.settings.worldRevision(id), overrides, fields };
    });
  }

  saveWorld(session: string, raw: z.input<typeof worldRequest>) {
    const input = worldRequest.parse(raw);

    return this.store.transaction(() => {
      const actor = this.sessions.require(session, true);
      const fingerprint = this.fingerprint(input);
      const prior = this.store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.action !== 'world-settings' || prior.fingerprint !== fingerprint)
          throw new ApplicationError({ status: 409, message: 'Operation changed.' });

        return JSON.parse(prior.result!);
      }

      if (input.id.startsWith('peloton:')) {
        const id = input.id.slice(8);
        const base = this.context.config.pelotons.find((value) => value.id === id);

        if (!base) throw new ApplicationError({ status: 404, message: 'Unknown peloton.' });
        configSchema.parse({ pelotons: [{ ...base, ...input.values, id }] });
      } else if (input.id.startsWith('blob:') && this.context.accounts.get(Number(input.id.slice(5)))) {
        configSchema.parse({ soloBlob: { ...this.context.config.soloBlob, ...input.values } });
      } else throw new ApplicationError({ status: 400, message: 'Unknown world settings.' });
      this.context.settings.saveWorld(input.id, input.values, input.revision);

      const after = {
        id: input.id,
        revision: this.context.settings.worldRevision(input.id),
        overrides: this.context.settings.world(input.id),
      };

      this.store.record(actor.player_id, input.operation, 'world-settings', 0, fingerprint, after);

      return after;
    });
  }
}
