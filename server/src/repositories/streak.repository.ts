import type { Streaks } from '#src/protocol/generated/profile_pb';
import { StreaksSchema } from '#src/protocol/generated/profile_pb';
import type { RiderDocuments } from '#src/repositories/rider-document.repository';
import { fromBinary, toBinary } from '@bufbuild/protobuf';

export class StreakRepository {
  constructor(private readonly documents: RiderDocuments) {}

  readStreaks(player: number) {
    const data = this.documents.get(player, 'streaks.bin');

    return data ? fromBinary(StreaksSchema, data) : null;
  }

  saveStreaks(player: number, streaks: Streaks) {
    this.documents.put(player, 'streaks.bin', toBinary(StreaksSchema, streaks));
  }
}
