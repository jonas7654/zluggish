import { movedToWeb } from '#src/http/game/web-page';
import { gameRedirect } from '#src/http/game/results';
import { profileUpdateSchema } from '#src/dtos/profiles.dto';
import { importFilenameSchema } from '#src/dtos/profile-import.dto';
import { parseProtobuf } from '#src/http/protobuf';
import { authenticated, csrf } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { PlayerProfileSchema, ProfileEntitlementsSchema } from '#src/protocol/generated/profile_pb';
import type { ImportFiles } from '#src/dtos/profile-import.dto';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

export function profileRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const imports = runtime.services.imports;
  imports.recover();

  app.on(['GET', 'POST'], '/profile/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      const files: ImportFiles = {};

      for (const name of importFilenameSchema.options) {
        const upload = form[name];

        if (!(upload instanceof File && upload.name)) continue;

        const key = importFilenameSchema.parse(name);

        files[key] = new Uint8Array(await upload.arrayBuffer());
      }

      if (
        !runtime.services.sessions.current(
          c.get('browserId'),
          c.get('browser'),
          runtime.services.accounts.identityOf(rider),
        )
      )
        throw new HTTPException(401);
      const stage = imports.prepare(rider, files);
      const browser = c.get('browser');

      if (browser.pendingImport) imports.cancel(rider, browser.pendingImport);

      runtime.services.sessions.transition(browser, { type: 'stage-import', stage });

      return gameRedirect(c, `/profile/${rider.username}/confirm/`);
    }

    return movedToWeb(c, runtime, 'Import profile data', '/import');
  });

  app.on(['GET', 'POST'], '/profile/:username/confirm/', async (c) => {
    const rider = authenticated(c);
    const stage = c.get('browser').pendingImport;

    if (!stage) return gameRedirect(c, `/profile/${rider.username}/`);
    const manifest = imports.inspect(rider, stage);

    const duplicate =
      manifest.sourceId &&
      runtime.services.accounts
        .list()
        .some((user) => user.player_id !== rider.player_id && user.official_player_id === manifest.sourceId);

    const mixed = !manifest.sourceId || (rider.official_player_id && rider.official_player_id !== manifest.sourceId);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      if (
        c.get('browser').pendingImport !== stage ||
        !runtime.services.sessions.current(
          c.get('browserId'),
          c.get('browser'),
          runtime.services.accounts.identityOf(rider),
        )
      )
        throw new HTTPException(409);

      if (form.cancel) imports.cancel(rider, stage);
      else {
        if (!form.confirm || ((duplicate || mixed) && !form.confirm_source)) throw new HTTPException(400);

        imports.publish(rider, stage, form.keep_name === 'on');
      }

      runtime.services.sessions.transition(c.get('browser'), { type: 'finish-import' });

      return gameRedirect(c, `/user/${rider.username}/`);
    }

    return movedToWeb(c, runtime, 'Confirm profile import', '/import');
  });

  function profileResponse(c: Context<RuntimeEnv>, id: number) {
    const profile = runtime.services.profiles.entitlements(runtime.services.profiles.get(id));

    return c.req.header('Accept')?.includes('application/json')
      ? c.json(runtime.services.profiles.companionProfile(profile, avatar(id)))
      : c.body(toBinary(PlayerProfileSchema, profile));
  }

  function avatar(id: number) {
    return runtime.services.files.exists(resolve(runtime.services.profiles.folder(id), 'avatarLarge.jpg'))
      ? `https://us-or-rly101.zwift.com/download/${id}/avatarLarge.jpg`
      : null;
  }

  app.on('GET', ['/api/profiles/me', '/api/profiles/me/'], (c) => profileResponse(c, authenticated(c).player_id));
  app.get('/api/profiles/me/entitlements', (c) => {
    const user = authenticated(c);
    const profile = runtime.services.profiles.entitlements(runtime.services.profiles.get(user.player_id));

    return c.body(
      toBinary(
        ProfileEntitlementsSchema,
        create(ProfileEntitlementsSchema, {
          entitlements: profile.entitlements,
        }),
      ),
    );
  });
  app.get('/api/profiles/:id', (c) => {
    const viewer = authenticated(c);

    const id = z.coerce.number().int().positive().safe().parse(c.req.param('id'));

    if (
      !runtime.services.accounts.get(id) &&
      !runtime.services.profiles.synthetic.has(BigInt(id)) &&
      !runtime.services.profiles.exists(id)
    )
      throw new HTTPException(404);
    const profile = runtime.services.profiles.forViewer(runtime.services.profiles.get(id), viewer.player_id);

    return c.json(
      runtime.services.profiles.companionProfile(
        profile,
        runtime.services.files.exists(resolve(runtime.services.profiles.folder(Number(profile.id)), 'avatarLarge.jpg'))
          ? `https://us-or-rly101.zwift.com/download/${profile.id}/avatarLarge.jpg`
          : null,
      ),
    );
  });
  app.put('/api/profiles/me/:id', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const update = profileUpdateSchema.parse(await c.req.json());

    const profile = runtime.services.profiles.get(user.player_id);

    if (update.countryCode !== undefined) profile.countryCode = update.countryCode;

    if (update.dob !== undefined) profile.dob = update.dob;

    if (update.emailAddress !== undefined) profile.email = update.emailAddress;

    if (update.firstName !== undefined) profile.firstName = update.firstName;

    if (update.lastName !== undefined) profile.lastName = update.lastName;

    if (update.height !== undefined) profile.heightInMillimeters = update.height;

    if (update.male !== undefined) profile.isMale = update.male;

    if (update.useMetric !== undefined) profile.useMetric = update.useMetric;

    if (update.weight !== undefined) profile.weightInGrams = update.weight;
    const current = runtime.services.accounts.get(user.player_id);

    if (!current?.enabled || current.auth_version !== user.auth_version || current.revision !== user.revision)
      throw new HTTPException(409, { message: 'User changed. Reload and retry.' });
    runtime.services.profiles.save(user.player_id, profile);

    return profileResponse(c, user.player_id);
  });
  app.on(['PUT'], ['/api/profiles/:id', '/api/profiles/:id/in-game-fields'], async (c) => {
    const user = authenticated(c);

    if (c.req.param('id') === '0') throw new HTTPException(400);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const profile = parseProtobuf(PlayerProfileSchema, new Uint8Array(await c.req.arrayBuffer()));

    const current = runtime.services.accounts.get(user.player_id);

    if (!current?.enabled || current.auth_version !== user.auth_version || current.revision !== user.revision)
      throw new HTTPException(409, { message: 'User changed. Reload and retry.' });
    runtime.services.profiles.save(user.player_id, profile);

    return c.body(null, 204);
  });
}
