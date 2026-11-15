import type { RepositoryContext } from '#src/context';
import { BaseService } from '#src/services/base.service';

/** The barrier that makes committed saves durable before they are acknowledged. */
export class DurabilityService extends BaseService {
  constructor(context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  start() {
    this.durabilityRepository.start();
  }

  changes() {
    return this.durabilityRepository.changes();
  }

  flush() {
    return this.durabilityRepository.flush();
  }

  close() {
    return this.durabilityRepository.close();
  }
}
