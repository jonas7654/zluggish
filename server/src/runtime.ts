import { Resources } from '#src/node/lifecycle/resources';
import { createServices } from '#src/composition';
import type { ResolvedConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import type { RepositoryContext } from '#src/context';
import type { Runtime } from '#src/http/runtime';
import { CheckpointRepository } from '#src/repositories/checkpoint.repository';
import { LockRepository } from '#src/repositories/lock.repository';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import { ImportsService } from '#src/services/profile-import.service';
import { Simulation } from '#src/world/simulation';
import { World } from '#src/world/state';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { DiscordService } from '#src/services/discord.service';

export async function openRuntime(config: ResolvedConfig, assets: string) {
  const resources = new Resources();
  const release = await new LockRepository().acquireStorageLock(config.storageDir);
  resources.defer(release);

  try {
    const accounts = new AccountsService(config.storageDir);
    resources.defer(() => accounts.close());
    const settings = accounts.repositories.settingsRepository;
    resources.defer(() => settings.close());
    const sessions = new SessionsService(accounts);
    const profiles = accounts.repositories.profileRepository;
    const world = new World();

    const tokens = z
      .object({ access: z.string(), refresh: z.string(), id: z.string() })
      .parse(JSON.parse(readFileSync(resolve(packageRoot(), '../assets/tokens.json'), 'utf8')));

    const context: RepositoryContext = {
      config,
      assets,
      accounts,
      sessions,
      profiles,
      settings,
      world,
      tokens,
    };

    const runtime: Runtime = Object.assign(context, { services: createServices(context) });

    new ImportsService(accounts, world).recover();
    const simulation = new Simulation(runtime);
    const checkpoints = new CheckpointRepository(accounts.db, resolve(config.storageDir, 'zluggish.db'));
    resources.defer(() => checkpoints.close());
    // Stops after the job runner and the simulation: the last flush covers their commits.
    resources.defer(() => runtime.services.durability.close());
    resources.defer(() => runtime.discord?.close());
    resources.defer(() => runtime.services.jobs.close());
    resources.defer(() => simulation.close());
    resources.defer(() => world.lifecycle.close());
    resources.defer(runtime.services.metrics.start(config.logging.metricsIntervalSeconds));
    await simulation.ready;
    simulation.start();
    runtime.services.durability.start();
    runtime.services.uploads.start();
    runtime.services.retention.schedule();
    runtime.services.jobs.start();
    checkpoints.start();

    if (config.integrations.discord.enabled) {
      try {
        runtime.discord = new DiscordService(runtime.accounts.repositories).startDiscord(runtime);
        world.presence = (id, joining) => runtime.discord?.online(id, joining);
      } catch {
        world.lifecycle.log.warn(
          'discord.configuration_failed',
          'Discord configuration failed; local riding remains available',
        );
      }
    }

    return { runtime, close: () => resources.close() };
  } catch (error) {
    try {
      await resources.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime initialization and cleanup failed', {
        cause: cleanupError,
      });
    }

    throw error;
  }
}
