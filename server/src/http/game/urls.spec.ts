import { validateConfig } from '#src/config/index';
import { gameUrls } from '#src/http/game/urls';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const auth = '{"launcher":"https://launcher.zwift.com/launcher","url":"https://secure.zwift.com/auth/"}';

await test('game URLs stay on the impersonated hosts without a public game URL', () => {
  assert.equal(gameUrls(validateConfig({}), auth), auth);
});

await test('game URLs move to the public game URL', () => {
  const config = validateConfig({ network: { api: { publicUrl: 'https://zwiftgame.example.com/' } } });

  assert.equal(
    gameUrls(config, auth),
    '{"launcher":"https://zwiftgame.example.com/launcher","url":"https://zwiftgame.example.com/auth/"}',
  );
  assert.equal(
    gameUrls(config, 'https://us-or-rly101.zwift.com/download/1/avatarLarge.jpg'),
    'https://zwiftgame.example.com/download/1/avatarLarge.jpg',
  );

  // Hosts that are not impersonated, and look-alikes, are left alone.
  for (const url of [
    // eslint-disable-next-line unicorn/prefer-https -- The CDN is plain HTTP and must stay on its own host.
    'http://cdn.zwift.com/gameassets/',
    'https://www.zwift.com',
    'https://secure.zwift.com.evil.test/',
  ])
    assert.equal(gameUrls(config, url), url);
});

await test('the public game URL must be an https origin', () => {
  // eslint-disable-next-line unicorn/prefer-https -- Rejecting plain HTTP is the point.
  assert.throws(() => validateConfig({ network: { api: { publicUrl: 'http://zwiftgame.example.com' } } }));
  assert.throws(() => validateConfig({ network: { api: { publicUrl: 'https://zwiftgame.example.com/game' } } }));
});
