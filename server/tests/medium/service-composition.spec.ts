import { RuntimeContext } from '#src/context';
import { AccountsService } from '#src/services/auth.service';
import { SessionsService } from '#src/services/browser-session.service';
import { mediumFixture } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('every service reads the runtime repositories and profile state', async (t) => {
  const f = await mediumFixture(t);
  const repositories = f.accounts.repositories;

  assert.equal(f.effects.runSync(RuntimeContext).accounts.repositories, repositories);
  assert.equal(f.effects.runSync(AccountsService), f.accounts);
  assert.equal(f.effects.runSync(SessionsService), f.sessions);
  assert.equal(repositories.profileRepository, f.profiles);
  assert.equal(repositories.settingsRepository, f.settings);
  assert.equal(repositories.accountsRepository, f.accounts.repository);
});
