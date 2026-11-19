import { packageRoot } from '#src/config/load';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Schema } from 'effect';

const dictionary = Schema.decodeUnknownSync(Schema.Struct({ bikeframes: Schema.Record(Schema.String, Schema.String) }))(
  JSON.parse(readFileSync(resolve(packageRoot(), '../assets/data/game_dictionary.txt'), 'utf8')),
);

export class ProfileJsonRepository {
  bikeFrameName(id: number) {
    return dictionary.bikeframes[String(id)] ?? '---';
  }
}
