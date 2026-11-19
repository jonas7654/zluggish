import { RuntimeContext } from '#src/context';
import type { RepositoryContext } from '#src/context';
import { RecordsService } from '#src/services/records.service';
import { SettingsService } from '#src/services/settings.service';
import { GoalService } from '#src/services/goals.service';
import { MetricsService } from '#src/services/metrics.service';
import { RecordDataService } from '#src/services/record-data.service';
import { SocialService } from '#src/services/social.service';
import { FitnessService } from '#src/services/fitness.service';
import { StorageService } from '#src/services/storage.service';
import { DocumentsService } from '#src/services/documents.service';
import { EventsService } from '#src/services/events.service';
import { IntegrationsService } from '#src/services/integrations.service';
import { ConnectionsService } from '#src/services/connections.service';
import { ProfilesService } from '#src/services/profile.service';
import { Layer, ManagedRuntime } from 'effect';

/** Every application service, built from the runtime context. */
export const servicesLayer = Layer.mergeAll(
  ProfilesService.layer,
  ConnectionsService.layer,
  IntegrationsService.layer,
  EventsService.layer,
  DocumentsService.layer,
  StorageService.layer,
  FitnessService.layer,
  SocialService.layer,
  RecordDataService.layer,
  MetricsService.layer,
  GoalService.layer,
  SettingsService.layer,
  RecordsService.layer,
);

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
