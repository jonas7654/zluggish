import { GarminRepository } from '#src/repositories/garmin.repository';
import { runtimeFixture } from '#tests/support/runtime';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { test } from 'node:test';

await test('Garmin imports FIT using garth-format tokens stored as encrypted documents', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Garmin Rider', 'test-password');
  const documents = f.accounts.repositories.riderDocuments;
  documents.put(
    rider.player_id,
    'garth/oauth1_token.json',
    JSON.stringify({
      oauth_token: 'synthetic',
      oauth_token_secret: 'synthetic-secret',
      domain: 'garmin.com',
    }),
  );
  documents.put(
    rider.player_id,
    'garth/oauth2_token.json',
    JSON.stringify({
      scope: '',
      jti: '',
      token_type: 'Bearer',
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      expires_in: 86_400,
      refresh_token_expires_in: 86_400,
      expires_at: Date.now() / 1000 + 86_400,
      refresh_token_expires_at: Date.now() / 1000 + 86_400,
    }),
  );
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://connectapi.garmin.com/upload-service/upload/fit');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer synthetic-access');
    assert.ok(init?.body instanceof FormData);
    const file = init.body.get('file');
    assert.ok(file instanceof Blob);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3]));
    uploads++;

    return Response.json({
      detailedImportResult: {
        successes: [{ internalId: 123 }],
        failures: [],
      },
    });
  });
  const garmin = new GarminRepository();
  const store = garmin.tokenStore(documents, rider.player_id);
  await garmin.uploadGarmin(store, 'garmin.com', 'ride.fit', new Uint8Array([1, 2, 3]));
  assert.equal(uploads, 1);
  assert.throws(() => garmin.garminClient(store, 'untrusted.example'), /Unsupported/);

  const stored = f.accounts.db
    .prepare("SELECT data, encrypted FROM rider_document WHERE name='garth/oauth2_token.json'")
    .get();

  assert.equal(stored?.encrypted, 1);
  assert.equal(Buffer.from(z.instanceof(Uint8Array).parse(stored?.data)).includes('synthetic-access'), false);
});
