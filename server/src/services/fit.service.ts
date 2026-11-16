import { FitDecoder } from '#src/repositories/fit-decoder.repository';
import type { PowerBests } from '#src/repositories/fit-decoder.repository';
import { fitWorkers } from '#src/repositories/fit.repository';
import { Metric, metrics } from '#src/repositories/metrics.repository';
import { BaseService } from '#src/services/base.service';

export class FitService extends BaseService {
  static decodeFit(bytes: Uint8Array) {
    return metrics.time(Metric.FitProcessing, () => new FitDecoder().decode(bytes));
  }

  static activityChart(bytes: Uint8Array) {
    return metrics.time(Metric.FitProcessing, () => new FitDecoder().chart(bytes));
  }

  /** Chart data computed in the FIT worker thread. */
  static chart(bytes: Uint8Array) {
    return fitWorkers.chart(bytes);
  }

  static powerBests(bytes: Uint8Array) {
    return fitWorkers.powerBests(bytes);
  }

  savePowerCurve(playerId: number, bytes: Uint8Array) {
    this.insertPowerBests(
      playerId,
      metrics.time(Metric.FitProcessing, () => new FitDecoder().powerBests(bytes)),
    );
  }

  insertPowerBests(playerId: number, curve: PowerBests, activity: number | null = null) {
    const weight = this.profileRepository.get(playerId).weightInGrams / 1000;

    if (weight <= 0) return;

    for (const { time, power } of curve.bests)
      this.fitnessRepository.insertPowerCurve(
        playerId,
        String(time),
        power,
        Number((power / weight).toFixed(2)),
        curve.timestamp,
        activity,
      );
  }
}
