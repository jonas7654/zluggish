import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';
import type { RiderDocumentName } from '#src/enum';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;

  const get = Effect.fn('DocumentsService.get')(function* (player: number, name: RiderDocumentName) {
    return repositories.riderDocuments.get(player, name);
  });

  const text = Effect.fn('DocumentsService.text')(function* (player: number, name: RiderDocumentName) {
    return repositories.riderDocuments.text(player, name);
  });

  const has = Effect.fn('DocumentsService.has')(function* (player: number, name: RiderDocumentName) {
    return repositories.riderDocuments.has(player, name);
  });

  const put = Effect.fn('DocumentsService.put')(function* (
    player: number,
    name: RiderDocumentName,
    data: Uint8Array | string,
  ) {
    repositories.riderDocuments.put(player, name, data);
  });

  const remove = Effect.fn('DocumentsService.remove')(function* (player: number, name: RiderDocumentName) {
    return repositories.riderDocuments.remove(player, name);
  });

  return { get, text, has, put, remove };
});

/** Rider state stored in the main database, by legacy file name. */
export class DocumentsService extends Context.Service<DocumentsService, Effect.Success<typeof make>>()(
  'zluggish/DocumentsService',
) {
  static readonly layer = Layer.effect(DocumentsService, make);
}
