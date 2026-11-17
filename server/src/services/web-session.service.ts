import { ApplicationError } from '#src/errors';
import type { AccountsService } from '#src/services/auth.service';
import { BaseService } from '#src/services/base.service';
import { z } from 'zod';

export interface WebSession {
  csrf: string;
  identity: string;
  expires: number;
  confirmedUntil: number;
  pendingImport?: string;
  stravaState?: string;
}

/** Only signed-in users hold server state. Anonymous requests use a double-submit CSRF
cookie, so requests without cookies cannot fill this store.
*/
export class WebSessionsService extends BaseService {
  readonly sessions = new Map<string, WebSession>();

  constructor(private readonly accounts: AccountsService) {
    super(accounts.repositories);
  }

  token() {
    return this.cryptoRepository.randomBytes(32).toString('base64url');
  }

  private hash(id: string) {
    return this.cryptoRepository.sha256(id);
  }

  /** A restart empties the map; a session found in the database is loaded back into it. */
  private restore(id: string) {
    const row = z
      .object({ csrf: z.string(), identity: z.string(), expires: z.number() })
      .nullable()
      .parse(
        this.accounts.db
          .prepare('SELECT csrf, identity, expires FROM web_session WHERE id_hash = ?')
          .get(this.hash(id)) ?? null,
      );

    if (!row) return;
    const session: WebSession = { ...row, confirmedUntil: 0 };
    this.sessions.set(id, session);

    return session;
  }

  find(id: string | undefined) {
    if (!id) return null;
    const session = this.sessions.get(id) ?? this.restore(id);

    if (!session) return null;

    if (session.expires <= Date.now()) {
      this.end(id);

      return null;
    }

    return session;
  }

  create(identity: string, confirmedUntil = 0) {
    const now = Date.now();

    for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);
    this.accounts.db.prepare('DELETE FROM web_session WHERE expires <= ?').run(now);

    if (this.sessions.size >= 10_000) throw new ApplicationError(503, 'Too many web sessions');
    const id = this.token();
    const session: WebSession = { csrf: this.token(), identity, expires: now + 86_400_000, confirmedUntil };
    this.sessions.set(id, session);
    this.accounts.db
      .prepare('INSERT INTO web_session (id_hash, csrf, identity, expires) VALUES (?, ?, ?, ?)')
      .run(this.hash(id), session.csrf, identity, session.expires);

    return { id, session };
  }

  end(id: string) {
    this.sessions.delete(id);

    if (id) this.accounts.db.prepare('DELETE FROM web_session WHERE id_hash = ?').run(this.hash(id));
  }

  user(id: string) {
    const session = this.find(id);

    if (!session) return null;
    const user = this.accounts.identity(session.identity);

    // An identity change (password, role, enabled state, revocation) ends the session and its confirmation.
    if (!user) this.end(id);

    return user;
  }

  require(id: string, manage = false, _confirm = true) {
    const user = this.user(id);

    if (!user) throw new ApplicationError(401, 'Sign in again.');

    if (manage && user.role !== 'administrator') throw new ApplicationError(403, 'Administrator role required.');

    return user;
  }

  current(id: string, identity: string) {
    return !!this.user(id) && this.sessions.get(id)?.identity === identity;
  }
}
