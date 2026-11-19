import type { RepositoryContext } from '#src/context';

/** Configure logging and expose the account and browser-session stores to the HTTP layer. */
export function createServices(context: RepositoryContext) {
  const logging = context.accounts.repositories.loggingRepository;
  logging.configure(context.config.logging);
  context.world.lifecycle.log = logging.child({ component: 'server' });
  context.world.lifecycle.intervalSeconds = context.config.logging.rideProgressIntervalSeconds;

  return { accounts: context.accounts, sessions: context.sessions };
}

export type Services = ReturnType<typeof createServices>;
