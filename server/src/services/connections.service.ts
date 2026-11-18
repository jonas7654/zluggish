import type { RepositoryContext } from '#src/context';
import { UnreadableCredentialsError } from '#src/errors';
import type { Connections } from '#src/repositories/connections.repository';
import { BaseService } from '#src/services/base.service';
import { UploadsService } from '#src/services/uploads.service';

export class ConnectionsService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  has(...args: Parameters<Connections['has']>) {
    return this.connectionsRepository.has(...args);
  }

  read(...args: Parameters<Connections['read']>) {
    return this.connectionsRepository.read(...args);
  }

  /** Saved credentials, or `unreadable` when the credentials key cannot decrypt them. */
  inspect(...[player, service]: Parameters<Connections['read']>) {
    try {
      return { credentials: this.connectionsRepository.read(player, service), unreadable: false };
    } catch (error) {
      if (!(error instanceof UnreadableCredentialsError)) throw error;
      this.context.world.lifecycle.log.warn('connections.unreadable', 'Saved credentials cannot be decrypted', {
        playerId: player,
        provider: service,
        error,
      });

      return { credentials: null, unreadable: true };
    }
  }

  save(...args: Parameters<Connections['save']>) {
    return this.connectionsRepository.save(...args);
  }

  remove(...args: Parameters<Connections['remove']>) {
    this.connectionsRepository.remove(...args);
    new UploadsService(this.context).revoke(args[0]);
  }
}
