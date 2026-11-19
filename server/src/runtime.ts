import { MetricsService } from '#src/services/metrics.service';
import { Resources } from '#src/node/lifecycle/resources';
import { createServices } from '#src/composition';
import { makeAppRuntime } from '#src/layers';
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
import { Schema } from 'effect';

import { DiscordService } from '#src/services/discord.service';
import { MatrixService } from '#src/services/matrix.service';

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

    const tokens = Schema.decodeUnknownSync(
      Schema.Struct({ access: Schema.String, refresh: Schema.String, id: Schema.String }),
    )(JSON.parse(readFileSync(resolve(packageRoot(), '../assets/tokens.json'), 'utf8')));

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

    const effects = makeAppRuntime(context);
    context.effects = effects;
    resources.defer(() => effects.dispose());
    const runtime: Runtime = Object.assign(context, { services: createServices(context), effects });

    new ImportsService(accounts, world).recover();
    const simulation = new Simulation(runtime);
    const checkpoints = new CheckpointRepository(accounts.db, resolve(config.storageDir, 'zluggish.db'));
    resources.defer(() => checkpoints.close());
    // Stops after the job runner and the simulation: the last flush covers their commits.
    resources.defer(() => runtime.services.durability.close());
    resources.defer(async () => {
      await Promise.all((runtime.bridges ?? []).map((bridge) => bridge.close()));
    });
    resources.defer(() => runtime.services.jobs.close());
    resources.defer(() => simulation.close());
    resources.defer(() => runtime.services.recovery.close());
    resources.defer(() => world.lifecycle.close());
    resources.defer(
      runtime.effects.runSync(MetricsService.use((service) => service.start(config.logging.metricsIntervalSeconds))),
    );
    await simulation.ready;
    simulation.start();
    const completionTimer = setInterval(() => runtime.services.rideCompletion.sweep(), 1000);
    completionTimer.unref();
    resources.defer(() => clearInterval(completionTimer));
    runtime.services.durability.start();
    runtime.services.recovery.start();
    runtime.services.uploads.start();
    runtime.services.retention.schedule();
    runtime.services.jobs.start();
    checkpoints.start();

    const bridges: NonNullable<Runtime['bridges']> = [];
    runtime.bridges = bridges;

    if (config.integrations.discord.enabled) {
      try {
        bridges.push(new DiscordService(runtime.accounts.repositories).startDiscord(runtime));
      } catch {
        world.lifecycle.log.warn(
          'discord.configuration_failed',
          'Discord configuration failed; local riding remains available',
        );
      }
    }

    if (config.integrations.matrix.enabled) {
      try {
        bridges.push(new MatrixService(runtime.accounts.repositories).startMatrix(runtime));
      } catch {
        world.lifecycle.log.warn(
          'matrix.configuration_failed',
          'Matrix configuration failed; local riding remains available',
        );
      }
    }

    if (bridges.length > 0)
      world.presence = (id, joining) => {
        for (const bridge of bridges) bridge.online(id, joining);
      };

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
