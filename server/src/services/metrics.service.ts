import type { RepositoryContext } from '#src/context';
import { metrics } from '#src/repositories/metrics.repository';
import { BaseService } from '#src/services/base.service';

/** Periodic telemetry: durations, sizes and counts only. Each report resets the window. */
export class MetricsService extends BaseService {
  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  start(intervalSeconds: number) {
    if (intervalSeconds === 0) return () => {};

    metrics.monitorEventLoop();

    const timer = setInterval(() => this.report(), intervalSeconds * 1000);
    timer.unref();

    return () => {
      clearInterval(timer);
      metrics.stopEventLoop();
    };
  }

  report() {
    this.context.world.lifecycle.log.info('metrics.summary', 'Persistence and latency metrics', {
      metrics: metrics.summary(),
    });
    metrics.reset();
  }

  summary() {
    return metrics.summary();
  }
}
