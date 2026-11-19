import { RideCompletionService } from '#src/services/ride-completion.service';
import { ManagementService } from '#src/services/management.service';
import type { RepositoryContext } from '#src/context';

export function createServices(context: RepositoryContext) {
  const logging = context.accounts.repositories.loggingRepository;
  logging.configure(context.config.logging);
  context.world.lifecycle.log = logging.child({ component: 'server' });
  context.world.lifecycle.intervalSeconds = context.config.logging.rideProgressIntervalSeconds;

  const rideCompletion = context.bridge!.runSync(RideCompletionService);

  const services = {
    accounts: context.accounts,
    management: new ManagementService(context, rideCompletion),
    sessions: context.sessions,
  };

  return services;
}

export type Services = ReturnType<typeof createServices>;
