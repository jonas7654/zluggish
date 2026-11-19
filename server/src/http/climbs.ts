import { climbSchema } from '#src/dtos/accounts.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { resolve } from 'node:path';
import { Schema } from 'effect';

const climbSegments = Schema.Record(
  Schema.String,
  Schema.Struct({
    watopia: Schema.Int.check(Schema.isGreaterThan(0)),
    france: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
);

/** The Strava segments of a climb portal road: the climb as ridden from Watopia and from France, by road. */
export function readClimbSegments(runtime: HttpRuntime) {
  return Schema.decodeUnknownSync(climbSegments)(
    JSON.parse(runtime.services.files.read(resolve(runtime.assets, 'data/climb_segments.txt'), 'utf8')),
  );
}

/** 'Cauberg (0.8 km / 57 m)' -> the bare name with its length and height; names in another form stay whole. */
export function climbFacts(label: string) {
  const match = /^(?<name>.+) \((?<km>\d+(?:\.\d+)?) km \/ (?<m>\d+) m\)$/.exec(label);

  if (!match?.groups) return { name: label, distanceKm: null, elevationM: null };

  return { name: match.groups.name!, distanceKm: Number(match.groups.km), elevationM: Number(match.groups.m) };
}

/** The climb portal roads the launcher offers, with their display names. */
export function readClimbs(runtime: HttpRuntime) {
  return Schema.decodeUnknownSync(Schema.Array(climbSchema))(
    JSON.parse(runtime.services.files.read(resolve(runtime.assets, 'data/climbs.txt'), 'utf8')),
  );
}
