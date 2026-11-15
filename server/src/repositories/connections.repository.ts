import type { ConnectionProvider, RiderDocumentName } from '#src/enum';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import type { RiderDocuments } from '#src/repositories/rider-document.repository';

export type Connection = ConnectionProvider;

export const connectionDocuments: Record<Connection, RiderDocumentName> = {
  zwift: 'zwift_credentials.bin',
  intervals: 'intervals_credentials.bin',
  garmin: 'garmin_credentials.bin',
  strava: 'strava_api.bin',
};

/** Provider credentials, encrypted with the credentials key before they are stored. */
export class Connections {
  constructor(private readonly documents: RiderDocuments) {}

  has(player: number, service: Connection) {
    return this.documents.has(player, connectionDocuments[service]);
  }

  read(player: number, service: Connection) {
    const data = this.documents.get(player, connectionDocuments[service]);

    return data ? new CryptoRepository().decryptCredentials(this.documents.key(), data) : null;
  }

  save(player: number, service: Connection, credentials: readonly [string, string]) {
    this.documents.put(
      player,
      connectionDocuments[service],
      new CryptoRepository().encryptCredentials(this.documents.key(), credentials),
    );
  }

  remove(player: number, service: Connection) {
    this.documents.remove(player, connectionDocuments[service]);
  }
}
