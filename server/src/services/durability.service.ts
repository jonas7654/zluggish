import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const durability = context.accounts.repositories.durabilityRepository;

  return {
    start: Effect.fn('DurabilityService.start')(function* () {
      durability.start();
    }),
    changes: Effect.fn('DurabilityService.changes')(function* () {
      return durability.changes();
    }),
    flush: Effect.fn('DurabilityService.flush')(function* () {
      yield* Effect.promise(() => durability.flush());
    }),
    close: Effect.fn('DurabilityService.close')(function* () {
      yield* Effect.promise(() => durability.close());
    }),
  };
});

/** The barrier that makes committed saves durable before they are acknowledged. */
export class DurabilityService extends Context.Service<DurabilityService, Effect.Success<typeof make>>()(
  'zluggish/DurabilityService',
) {
  static readonly layer = Layer.effect(DurabilityService, make);
}
