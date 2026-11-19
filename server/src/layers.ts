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
import { FilesService } from '#src/services/files.service';
import { StreakService } from '#src/services/streak.service';
import { FitService } from '#src/services/fit.service';
import { AchievementService } from '#src/services/achievement.service';
import { MessageService } from '#src/services/message.service';
import { EventCatalogService } from '#src/services/event-catalog.service';
import { ProfileJsonService } from '#src/services/profile-json.service';
import { WorkoutsService } from '#src/services/workout.service';
import { JobsService } from '#src/services/jobs.service';
import { ImportsService } from '#src/services/profile-import.service';
import { DurabilityService } from '#src/services/durability.service';
import { RetentionService } from '#src/services/retention.service';
import { Layer, ManagedRuntime } from 'effect';

/** Services that use only repositories. */
const foundationLayer = Layer.mergeAll(
  StreakService.layer,
  JobsService.layer,
  ImportsService.layer,
  DurabilityService.layer,
  FitService.layer,
  AchievementService.layer,
  MessageService.layer,
  EventCatalogService.layer,
  ProfileJsonService.layer,
  FilesService.layer,
  DocumentsService.layer,
);

/** Every application service, built from the runtime context. Each tier may use the ones below it. */
export const servicesLayer = Layer.mergeAll(
  WorkoutsService.layer,
  ProfilesService.layer,
  RetentionService.layer,
  ConnectionsService.layer,
  IntegrationsService.layer,
  EventsService.layer,
  StorageService.layer,
  FitnessService.layer,
  SocialService.layer,
  RecordDataService.layer,
  MetricsService.layer,
  GoalService.layer,
  SettingsService.layer,
  RecordsService.layer,
).pipe(Layer.provideMerge(foundationLayer));

/** Every service an application effect may use. Listed rather than inferred: the runtime context
refers to the runtime, so an inferred type would be circular.
*/
export type AppServices =
  | RuntimeContext
  | JobsService
  | ImportsService
  | DurabilityService
  | RetentionService
  | StreakService
  | FitService
  | AchievementService
  | MessageService
  | EventCatalogService
  | ProfileJsonService
  | FilesService
  | DocumentsService
  | WorkoutsService
  | ProfilesService
  | ConnectionsService
  | IntegrationsService
  | EventsService
  | StorageService
  | FitnessService
  | SocialService
  | RecordDataService
  | MetricsService
  | GoalService
  | SettingsService
  | RecordsService;

/** The application layer for one runtime context. */
export function appLayer(context: RepositoryContext) {
  return servicesLayer.pipe(Layer.provideMerge(Layer.succeed(RuntimeContext, context)));
}

/** Runs application effects. HTTP handlers, sockets and the world loop use it at their edges. */
export function makeAppRuntime(context: RepositoryContext): AppRuntime {
  return ManagedRuntime.make(appLayer(context));
}

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;
