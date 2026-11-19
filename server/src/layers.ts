import { RuntimeContext } from '#src/context';
import type { RepositoryContext } from '#src/context';
import { RecordsService } from '#src/services/records.service';
import { Layer, ManagedRuntime } from 'effect';

/** Every application service, built from the runtime context. */
export const servicesLayer = Layer.mergeAll(RecordsService.layer);

export type AppServices = Layer.Success<typeof servicesLayer> | RuntimeContext;

/** The application layer for one runtime context. */
export function appLayer(context: RepositoryContext) {
  return servicesLayer.pipe(Layer.provideMerge(Layer.succeed(RuntimeContext, context)));
}

/** Runs application effects. HTTP handlers, sockets and the world loop use it at their edges. */
export function makeAppRuntime(context: RepositoryContext): ManagedRuntime.ManagedRuntime<AppServices, never> {
  return ManagedRuntime.make(appLayer(context));
}

export type AppRuntime = ReturnType<typeof makeAppRuntime>;
