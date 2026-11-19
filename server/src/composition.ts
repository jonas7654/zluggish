import { RideCompletionService } from '#src/services/ride-completion.service';
import { ManagementService } from '#src/services/management.service';
import type { RepositoryContext } from '#src/context';
import { ActivitiesService } from '#src/services/activities.service';
import { JobsService } from '#src/services/jobs.service';
import { RideRecoveryService } from '#src/services/ride-recovery.service';
import { UploadsService } from '#src/services/uploads.service';

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
    uploads: new UploadsService(context),
    activities: new ActivitiesService(context),
    recovery: new RideRecoveryService(context),
  };

  const jobs = context.bridge!.runSync(JobsService);
  services.activities.registerJobs(jobs);
  services.uploads.registerJobs(jobs);

  return services;
}

export type Services = ReturnType<typeof createServices>;
