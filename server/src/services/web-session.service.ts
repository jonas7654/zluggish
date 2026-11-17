import { ApplicationError } from '#src/errors';
import type { AccountsService } from '#src/services/auth.service';
import { BaseService } from '#src/services/base.service';

export interface WebSession {
  csrf: string;
  identity: string;
  expires: number;
  confirmedUntil: number;
  pendingImport?: string;
  stravaState?: string;
}

/** Only signed-in riders hold server state. Anonymous requests use a double-submit CSRF
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

  find(id: string | undefined) {
    const session = id ? this.sessions.get(id) : undefined;

    if (!session) return null;

    if (session.expires <= Date.now()) {
      this.sessions.delete(id!);

      return null;
    }

    return session;
  }

  create(identity: string, confirmedUntil = 0) {
    const now = Date.now();

    for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);

    if (this.sessions.size >= 10_000) throw new ApplicationError(503, 'Too many web sessions');
    const id = this.token();
    const session: WebSession = { csrf: this.token(), identity, expires: now + 86_400_000, confirmedUntil };
    this.sessions.set(id, session);

    return { id, session };
  }

  end(id: string) {
    this.sessions.delete(id);
  }

  rider(id: string) {
    const session = this.find(id);

    if (!session) return null;
    const rider = this.accounts.identity(session.identity);

    // An identity change (password, role, enabled state, revocation) ends the session and its confirmation.
    if (!rider) this.sessions.delete(id);

    return rider;
  }

  require(id: string, manage = false, _confirm = true) {
    const rider = this.rider(id);

    if (!rider) throw new ApplicationError(401, 'Sign in again.');

    if (manage && rider.role !== 'administrator') throw new ApplicationError(403, 'Administrator role required.');

    return rider;
  }

  current(id: string, identity: string) {
    return !!this.rider(id) && this.sessions.get(id)?.identity === identity;
  }
}
