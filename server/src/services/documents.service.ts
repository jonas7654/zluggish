import type { RiderDocumentName } from '#src/enum';
import type { RepositoryContext } from '#src/context';
import { BaseService } from '#src/services/base.service';

/** Rider state stored in the main database, by legacy file name. */
export class DocumentsService extends BaseService {
  constructor(context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  get(player: number, name: RiderDocumentName) {
    return this.riderDocuments.get(player, name);
  }

  text(player: number, name: RiderDocumentName) {
    return this.riderDocuments.text(player, name);
  }

  has(player: number, name: RiderDocumentName) {
    return this.riderDocuments.has(player, name);
  }

  put(player: number, name: RiderDocumentName, data: Uint8Array | string) {
    this.riderDocuments.put(player, name, data);
  }

  remove(player: number, name: RiderDocumentName) {
    return this.riderDocuments.remove(player, name);
  }
}
