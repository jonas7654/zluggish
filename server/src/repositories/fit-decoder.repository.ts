import { Decoder, Stream } from '@garmin/fitsdk';
import { z } from 'zod';

const recordSchema = z.object({
  power: z.number().optional(),
  cadence: z.number().optional(),
  heartRate: z.number().optional(),
  distance: z.number().optional(),
  speed: z.number().optional(),
  enhancedSpeed: z.number().optional(),
  timestamp: z.number().optional(),
  altitude: z.number().optional(),
  enhancedAltitude: z.number().optional(),
  positionLat: z.number().optional(),
  positionLong: z.number().optional(),
});

export type ActivityChart = {
  powerInWatts: number[];
  cadencePerMin: number[];
  heartRate: number[];
  distanceInCm: number[];
  speedInCmPerSec: number[];
  timeInSec: number[];
  altitudeInCm: number[];
  latlng: number[][];
};

export type PowerBests = { timestamp: number; bests: { time: number; power: number }[] };

/** Pure FIT computations. The FIT worker and synchronous callers share them. */
export class FitDecoder {
  decode(bytes: Uint8Array) {
    const decoder = new Decoder(Stream.fromByteArray(bytes));

    if (!decoder.isFIT()) throw new Error('Invalid FIT activity');

    const { messages, errors } = decoder.read({
      convertDateTimesToDates: false,
      convertTypesToStrings: false,
    });

    if (errors.length > 0) throw new AggregateError(errors, 'Invalid FIT activity', { cause: errors[0] });

    return {
      records: z.array(recordSchema).parse(messages.recordMesgs ?? []),
      timestamp:
        messages.activityMesgs?.at(-1)?.timestamp === undefined
          ? Math.floor(Date.now() / 1000)
          : z.number().parse(messages.activityMesgs.at(-1)?.timestamp) + 631_065_600,
    };
  }

  chart(bytes: Uint8Array): ActivityChart {
    const { records } = this.decode(bytes);

    const data: ActivityChart = {
      powerInWatts: [],
      cadencePerMin: [],
      heartRate: [],
      distanceInCm: [],
      speedInCmPerSec: [],
      timeInSec: [],
      altitudeInCm: [],
      latlng: [],
    };

    let start: number | undefined;
    const step = Math.max(1, Math.floor(records.length / 1000));

    for (let index = 0; index < records.length; index++) {
      const record = records[index];

      if (!record || record.timestamp === undefined) continue;
      start ??= record.timestamp;

      if (index % step) continue;
      const altitude = record.enhancedAltitude ?? record.altitude;
      const speed = record.enhancedSpeed ?? record.speed;

      data.powerInWatts.push(Math.trunc(record.power ?? 0));
      data.cadencePerMin.push(Math.trunc(record.cadence ?? 0));
      data.heartRate.push(Math.trunc(record.heartRate ?? 0));
      data.distanceInCm.push(Math.trunc((record.distance ?? 0) * 100));
      data.speedInCmPerSec.push(Math.trunc((speed ?? 0) * 100));
      data.timeInSec.push(record.timestamp - start);
      data.altitudeInCm.push(Math.trunc((altitude ?? 0) * 100));
      data.latlng.push([
        Number(((record.positionLat ?? 0) / 11_930_465).toFixed(6)),
        Number(((record.positionLong ?? 0) / 11_930_465).toFixed(6)),
      ]);
    }

    return data;
  }

  /** Best average power for the power-curve durations, in whole watts. */
  powerBests(bytes: Uint8Array): PowerBests {
    const { records, timestamp } = this.decode(bytes);
    const power = records.map((record) => Math.trunc(record.power ?? 0));
    const bests = [];

    for (const time of [5, 60, 300, 1200]) {
      if (power.length < time) continue;
      let sum = power.slice(0, time).reduce((total, value) => total + value, 0);
      let best = Math.floor(sum / time);

      for (let index = time; index < power.length; index++) {
        sum += (power[index] ?? 0) - (power[index - time] ?? 0);
        best = Math.max(best, Math.floor(sum / time));
      }

      bests.push({ time, power: best });
    }

    return { timestamp, bests };
  }
}
