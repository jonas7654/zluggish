import { ImportsService } from '#src/services/profile-import.service';
import { ConnectionsService } from '#src/services/connections.service';
import { IntegrationsService } from '#src/services/integrations.service';
import { DocumentsService } from '#src/services/documents.service';
import { effectRoutes } from '#src/http/effect';
import { SettingsService } from '#src/services/settings.service';
import { Effect, Schema } from 'effect';
import { Strict, withDefault } from '#src/schema';
import { DownloadFile } from '#src/enum';
import type { Hono, Context } from 'hono';
import { ApplicationError } from '#src/errors';
import { importFilenameSchema } from '#src/dtos/profile-import.dto';
import type { ImportFiles } from '#src/dtos/profile-import.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { asProviderFailure } from '#src/http/web-connections';
import type { WebEnv } from '#src/http/web-app';

export function webProfileRoutes(app: Hono<WebEnv>, runtime: HttpRuntime) {
  const appRoutes = effectRoutes(app, runtime);

  const { management, accounts } = runtime.services;
  const imports = runtime.effects.runSync(ImportsService);
  const { sessions } = management;

  function context(c: Context<WebEnv>) {
    const id = c.get('sessionId');
    const user = sessions.require(id);
    const session = sessions.find(id)!;

    return { id, user, session };
  }

  function review(c: Context<WebEnv>) {
    const { user, session } = context(c);
    const stage = session.pendingImport;

    if (!stage) return null;
    const manifest = runtime.effects.runSync(imports.inspect(user, stage));

    const confirmSource =
      !manifest.sourceId ||
      Boolean(user.official_player_id && user.official_player_id !== manifest.sourceId) ||
      accounts
        .list()
        .some((other) => other.player_id !== user.player_id && other.official_player_id === manifest.sourceId);

    return {
      stage,
      firstName: manifest.firstName,
      lastName: manifest.lastName,
      sourceId: manifest.sourceId,
      files: manifest.files,
      confirmSource,
    };
  }

  function stageFiles(c: Context<WebEnv>, identity: string, files: ImportFiles) {
    const { id, user, session } = context(c);

    if (!sessions.current(id, identity))
      throw new ApplicationError({ status: 401, message: 'Session changed. Sign in again.' });

    if (runtime.world.active(user.player_id))
      throw new ApplicationError({ status: 409, message: 'Finish the active ride before importing.' });
    let stage: string;

    try {
      stage = runtime.effects.runSync(imports.prepare(user, files));
    } catch {
      throw new ApplicationError({
        status: 400,
        message: 'Could not import these files. Select valid user data and retry.',
      });
    }

    if (session.pendingImport) runtime.effects.runSync(imports.cancel(user, session.pendingImport));
    session.pendingImport = stage;

    return c.json({ review: review(c) });
  }

  appRoutes.get('/api/me/export', (c) =>
    Effect.gen(function* () {
      const documentsService = yield* DocumentsService;

      const { user } = context(c);

      return c.json({
        filenames: Object.values(DownloadFile).filter((name) => documentsService.has(user.player_id, name)),
      });
    }),
  );
  appRoutes.get('/api/me/export/:filename', (c) =>
    Effect.gen(function* () {
      const documentsService = yield* DocumentsService;

      const { user } = context(c);
      const filename = Schema.decodeUnknownSync(Schema.Enum(DownloadFile))(c.req.param('filename'));
      const data = yield* documentsService.get(user.player_id, filename);

      if (!data) throw new ApplicationError({ status: 404, message: 'File not found.' });

      return c.body(new Uint8Array(data), 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
    }),
  );
  appRoutes.post('/api/me/power-curves', (c) =>
    Effect.gen(function* () {
      const integrationsService = yield* IntegrationsService;

      const { user } = context(c);

      const input = Schema.decodeUnknownSync(Schema.Struct({ confirm: Schema.Literal(true), create: Schema.Boolean }))(
        yield* Effect.promise(() => c.req.json()),
      );

      if (input.create) runtime.services.activities.rebuildPowerCurves(user.player_id);
      else yield* integrationsService.deletePowerCurve(user.player_id);

      return c.json({ message: input.create ? 'Power curves rebuild queued.' : 'Power curves deleted.' });
    }),
  );

  app.get('/api/me/import', (c) => {
    context(c);

    return c.json({ filenames: Object.values(importFilenameSchema.enums), review: review(c) });
  });
  app.post('/api/me/import', async (c) => {
    const { user } = context(c);
    const identity = accounts.identityOf(user);
    const form = await c.req.parseBody();
    const files: ImportFiles = {};

    for (const name of Object.values(importFilenameSchema.enums)) {
      const upload = form[name];

      if (upload instanceof File && upload.name) files[name] = new Uint8Array(await upload.arrayBuffer());
    }

    return stageFiles(c, identity, files);
  });
  app.post('/api/me/import/confirm', async (c) => {
    const input = Schema.decodeUnknownSync(
      Strict({
        stage: Schema.String,
        cancel: Schema.Boolean.pipe(withDefault(false)),
        keepName: Schema.Boolean.pipe(withDefault(false)),
        confirmSource: Schema.Boolean.pipe(withDefault(false)),
      }),
    )(await c.req.json());

    const { user, session } = context(c);
    const current = review(c);

    if (!current || current.stage !== input.stage)
      throw new ApplicationError({ status: 409, message: 'The import changed. Reload and review it again.' });

    if (input.cancel) runtime.effects.runSync(imports.cancel(user, current.stage));
    else {
      if (current.confirmSource && !input.confirmSource)
        throw new ApplicationError({ status: 400, message: 'Confirm the import source first.' });

      if (runtime.world.active(user.player_id))
        throw new ApplicationError({ status: 409, message: 'Finish the active ride before importing.' });
      runtime.effects.runSync(imports.publish(user, current.stage, input.keepName));
    }

    delete session.pendingImport;

    return c.json({ user: management.publicUser(accounts.get(user.player_id)!), review: null });
  });

  const connection = (c: Context<WebEnv>) =>
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      const { user } = context(c);

      const resolved = SettingsService.resolveRiderSettings(
        runtime.config.riderDefaults,
        yield* settings.read(user.player_id),
      );

      return c.json({
        connected: yield* (yield* ConnectionsService).has(user.player_id, 'zwift'),
        upload: resolved.uploads.zwift.enabled,
        click: resolved.devices.zwiftClick.enabled,
      });
    });

  appRoutes.get('/api/me/zwift', connection);
  appRoutes.put('/api/me/zwift', (c) =>
    Effect.gen(function* () {
      const connectionsService = yield* ConnectionsService;

      const settingsService = yield* SettingsService;

      const input = Schema.decodeUnknownSync(
        Strict({
          username: Schema.String.check(Schema.isMaxLength(500)),
          password: Schema.String.check(Schema.isMaxLength(1000)),
          upload: Schema.Boolean,
          click: Schema.Boolean,
        }),
      )(yield* Effect.promise(() => c.req.json()));

      const { user } = context(c);
      const username = input.username.trim();

      if (Boolean(username) !== Boolean(input.password))
        throw new ApplicationError({ status: 400, message: 'Enter both username and password.' });

      if (!username && !(yield* connectionsService.has(user.player_id, 'zwift')) && (input.upload || input.click))
        throw new ApplicationError({ status: 400, message: 'Save credentials before enabling uploads or Click.' });

      if (username) yield* connectionsService.save(user.player_id, 'zwift', [username, input.password]);
      yield* settingsService.save(user.player_id, {
        ...(yield* settingsService.read(user.player_id)),
        'uploads.zwift.enabled': input.upload,
        'devices.zwiftClick.enabled': input.click,
      });

      return yield* connection(c);
    }),
  );
  appRoutes.delete('/api/me/zwift', (c) => {
    const { user } = context(c);
    runtime.services.uploads.disconnect(user.player_id, 'zwift_credentials.bin');

    return connection(c);
  });
  appRoutes.post('/api/me/zwift/import', (c) =>
    Effect.gen(function* () {
      const connectionsService = yield* ConnectionsService;

      const integrationsService = yield* IntegrationsService;

      const input = Schema.decodeUnknownSync(Strict({ profile: Schema.Boolean, achievements: Schema.Boolean }))(
        yield* Effect.promise(() => c.req.json()),
      );

      const { user } = context(c);
      const identity = accounts.identityOf(user);
      const credentials = yield* connectionsService.read(user.player_id, 'zwift');

      if (!credentials || (!input.profile && !input.achievements))
        throw new ApplicationError({ status: 400, message: 'Save credentials and choose at least one download.' });

      if (runtime.world.active(user.player_id))
        throw new ApplicationError({ status: 409, message: 'Finish the active ride before importing.' });

      const files: ImportFiles = yield* integrationsService
        .downloadOfficialData(credentials[0], credentials[1], input.profile, input.achievements)
        .pipe(asProviderFailure(runtime, 400, 'Download failed. Existing user data was retained.'));

      return stageFiles(c, identity, files);
    }),
  );
}
