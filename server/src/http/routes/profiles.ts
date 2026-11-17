import { profileUpdateSchema } from '#src/dtos/profiles.dto';
import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { PlayerProfileSchema, ProfileEntitlementsSchema } from '#src/protocol/generated/profile_pb';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

export function profileRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  runtime.services.imports.recover();

  app.get('/download/:id/avatarLarge.jpg', (c) => {
    const id = z.coerce.number().int().positive().safe().parse(c.req.param('id'));

    const path = resolve(runtime.services.profiles.folder(id), 'avatarLarge.jpg');

    if (!runtime.services.files.exists(path)) throw new HTTPException(404);

    return c.body(runtime.services.files.read(path), 200, { 'Content-Type': 'image/jpeg' });
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
