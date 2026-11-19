import { RideCompletionService } from '#src/services/ride-completion.service';
import { ManagementService } from '#src/services/management.service';
import type { RepositoryContext } from '#src/context';
import { ActivitiesService } from '#src/services/activities.service';
import { ConnectionsService } from '#src/services/connections.service';
import { EventsService } from '#src/services/events.service';
import { FilesService } from '#src/services/files.service';
import { DocumentsService } from '#src/services/documents.service';
import { DurabilityService } from '#src/services/durability.service';
import { IntegrationsService } from '#src/services/integrations.service';
import { JobsService } from '#src/services/jobs.service';
import { ImportsService } from '#src/services/profile-import.service';
import { ProfilesService } from '#src/services/profile.service';
import { RetentionService } from '#src/services/retention.service';
import { RideRecoveryService } from '#src/services/ride-recovery.service';
import { UploadsService } from '#src/services/uploads.service';
import { WorkoutsService } from '#src/services/workout.service';

export function createServices(context: RepositoryContext) {
  const logging = context.accounts.repositories.loggingRepository;
  logging.configure(context.config.logging);
  context.world.lifecycle.log = logging.child({ component: 'server' });
  context.world.lifecycle.intervalSeconds = context.config.logging.rideProgressIntervalSeconds;

  const rideCompletion = new RideCompletionService(context);
  context.accounts.onRevoke = (id) => rideCompletion.cancel(id);

  const services = {
    rideCompletion,
    accounts: context.accounts,
    management: new ManagementService(context, rideCompletion),
    sessions: context.sessions,
    profiles: new ProfilesService(context),
    connections: new ConnectionsService(context),
    documents: new DocumentsService(context),
    durability: new DurabilityService(context),
    imports: new ImportsService(context.accounts, context.world),
    workouts: new WorkoutsService(context),
    uploads: new UploadsService(context),
    files: new FilesService(context.accounts.repositories),
    events: new EventsService(context),
    activities: new ActivitiesService(context),
    integrations: new IntegrationsService(context),
    jobs: new JobsService(context),
    recovery: new RideRecoveryService(context),
    retention: new RetentionService(context.accounts.repositories, context.config.retention, context.config.storageDir),
  };

  services.activities.registerJobs(services.jobs);
  services.uploads.registerJobs(services.jobs);
  services.retention.registerJobs(services.jobs);

  return services;
}

export type Services = ReturnType<typeof createServices>;
