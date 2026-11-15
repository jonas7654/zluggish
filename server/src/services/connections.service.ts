import type { RepositoryContext } from '#src/context';
import type { Connections } from '#src/repositories/connections.repository';
import { BaseService } from '#src/services/base.service';

export class ConnectionsService extends BaseService {
  constructor(context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  has(...args: Parameters<Connections['has']>) {
    return this.connectionsRepository.has(...args);
  }

  read(...args: Parameters<Connections['read']>) {
    return this.connectionsRepository.read(...args);
  }

  save(...args: Parameters<Connections['save']>) {
    return this.connectionsRepository.save(...args);
  }

  remove(...args: Parameters<Connections['remove']>) {
    return this.connectionsRepository.remove(...args);
  }
}
