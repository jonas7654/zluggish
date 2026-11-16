import { ApplicationError } from '#src/errors';
import type { AccountsService } from '#src/services/auth.service';
import { BaseService } from '#src/services/base.service';

export interface WebSession {
  csrf: string;
  identity: string | null;
  expires: number;
  confirmedUntil: number;
}

export class WebSessionsService extends BaseService {
  readonly sessions = new Map<string, WebSession>();

  constructor(private readonly accounts: AccountsService) {
    super(accounts.repositories);
  }

  open(id?: string) {
    const now = Date.now();

    for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);

    if (id && this.sessions.has(id)) return { id, session: this.sessions.get(id)! };

    if (this.sessions.size >= 10_000) throw new ApplicationError(503, 'Too many web sessions');
    const fresh = this.cryptoRepository.randomBytes(32).toString('base64url');

    const session: WebSession = {
      csrf: this.cryptoRepository.randomBytes(32).toString('base64url'),
      identity: null,
      expires: now + 86_400_000,
      confirmedUntil: 0,
    };

    this.sessions.set(fresh, session);

    return { id: fresh, session };
  }

  end(id: string) {
    this.sessions.delete(id);
  }

  rider(id: string) {
    const session = this.sessions.get(id);

    if (!session || session.expires <= Date.now() || !session.identity) return null;
    const rider = this.accounts.identity(session.identity);

    if (!rider) {
      session.identity = null;
      session.confirmedUntil = 0;
    }

    return rider;
  }

  require(id: string, manage = false, confirm = true) {
    const rider = this.rider(id);

    if (!rider) throw new ApplicationError(401, 'Sign in again.');

    if (manage && rider.role !== 'administrator') throw new ApplicationError(403, 'Administrator role required.');

    if (manage && confirm && this.sessions.get(id)!.confirmedUntil <= Date.now())
      throw new ApplicationError(403, 'Password confirmation necessary.');

    return rider;
  }

  current(id: string, identity: string) {
    return this.rider(id) && this.sessions.get(id)?.identity === identity;
  }
}
