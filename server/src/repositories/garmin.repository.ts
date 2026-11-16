import { DeliveryRefusedError, refused } from '#src/errors';
import type { RiderDocuments } from '#src/repositories/rider-document.repository';
import { SessionRepository } from '#src/repositories/session.repository';
import type { OAuth1Token, TokenStore, Tokens } from 'garminconnect-js';
import { Garmin, GarminAuthError, GarminClient, GarminHttpError, MemoryTokenStore } from 'garminconnect-js';
import { z } from 'zod';

const oauth1 = z.object({
  oauth_token: z.string(),
  oauth_token_secret: z.string(),
  mfa_token: z.string().optional(),
  mfa_expiration_timestamp: z.string().optional(),
  domain: z.string().optional(),
});

function oauth1Token(text: string) {
  const parsed = oauth1.parse(JSON.parse(text));
  const token: OAuth1Token = { oauth_token: parsed.oauth_token, oauth_token_secret: parsed.oauth_token_secret };

  if (parsed.mfa_token !== undefined) token.mfa_token = parsed.mfa_token;

  if (parsed.mfa_expiration_timestamp !== undefined) token.mfa_expiration_timestamp = parsed.mfa_expiration_timestamp;

  if (parsed.domain !== undefined) token.domain = parsed.domain;

  return token;
}

const oauth2 = z.object({
  scope: z.string(),
  jti: z.string(),
  token_type: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  refresh_token_expires_in: z.number(),
  expires_at: z.number(),
  refresh_token_expires_at: z.number(),
});

/** garth-format tokens, kept as encrypted rider documents. */
class DocumentTokenStore implements TokenStore {
  constructor(
    private readonly documents: RiderDocuments,
    private readonly player: number,
  ) {}

  load(): Promise<Tokens | null> {
    return Promise.try(() => {
      const first = this.documents.text(this.player, 'garth/oauth1_token.json');
      const second = this.documents.text(this.player, 'garth/oauth2_token.json');

      return first && second ? { oauth1: oauth1Token(first), oauth2: oauth2.parse(JSON.parse(second)) } : null;
    });
  }

  save(tokens: Tokens) {
    return Promise.try(() => {
      this.documents.put(this.player, 'garth/oauth1_token.json', JSON.stringify(tokens.oauth1));
      this.documents.put(this.player, 'garth/oauth2_token.json', JSON.stringify(tokens.oauth2));
    });
  }

  clear() {
    return Promise.try(() => {
      this.documents.remove(this.player, 'garth/oauth1_token.json');
      this.documents.remove(this.player, 'garth/oauth2_token.json');
    });
  }
}

export class GarminRepository {
  tokenStore(documents: RiderDocuments, player: number): TokenStore {
    return new DocumentTokenStore(documents, player);
  }

  garminClient(store: TokenStore | null, domain: string) {
    if (!['garmin.com', 'garmin.cn'].includes(domain)) throw new Error('Unsupported Garmin domain');

    return new GarminClient({
      tokenStore: store ?? new MemoryTokenStore(),
      isCn: domain === 'garmin.cn',
      timeoutMs: 30_000,
      retries: 0,
    });
  }

  /** Authorization stays in memory until the owning browser attempt is validated. */
  async saveAuthorization(store: TokenStore, client: GarminClient) {
    const tokens = client.getTokens();

    if (!tokens) throw new Error('Missing Garmin authorization');
    await store.save(tokens);
  }

  /** Garmin rejects a duplicate import with 409: the activity is already there. */
  async uploadGarmin(store: TokenStore, domain: string, filename: string, fit: Uint8Array) {
    const client = this.garminClient(store, domain);

    if (!(await client.loadTokens())) throw new DeliveryRefusedError('garmin_unauthorized');

    try {
      await new Garmin(client).importActivity(
        new SessionRepository().binaryBlob(fit),
        filename.endsWith('.fit') ? filename : 'activity.fit',
      );
    } catch (error) {
      const http = error instanceof GarminHttpError ? error : error instanceof Error ? error.cause : null;

      if (http instanceof GarminHttpError && http.status === 409) return;

      if (http instanceof GarminHttpError && refused(http.status))
        throw new DeliveryRefusedError(`garmin_${http.status}`);

      if (error instanceof GarminAuthError) throw new DeliveryRefusedError('garmin_unauthorized');
      throw error;
    }
  }
}
