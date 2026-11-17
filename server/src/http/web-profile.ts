import { z } from 'zod';
import { DownloadFile } from '#src/enum';
import type { Hono, Context } from 'hono';
import { ApplicationError } from '#src/errors';
import { importFilenameSchema } from '#src/dtos/profile-import.dto';
import type { ImportFiles } from '#src/dtos/profile-import.dto';
import type { HttpRuntime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';

export function webProfileRoutes(app: Hono<WebEnv>, runtime: HttpRuntime) {
  const { management, accounts, imports, connections, settings, integrations } = runtime.services;
  const { sessions } = management;

  function context(c: Context<WebEnv>) {
    const id = c.get('sessionId');
    const rider = sessions.require(id);
    const session = sessions.find(id)!;

    return { id, rider, session };
  }

  function review(c: Context<WebEnv>) {
    const { rider, session } = context(c);
    const stage = session.pendingImport;

    if (!stage) return null;
    const manifest = imports.inspect(rider, stage);

    const confirmSource =
      !manifest.sourceId ||
      Boolean(rider.official_player_id && rider.official_player_id !== manifest.sourceId) ||
      accounts
        .list()
        .some((other) => other.player_id !== rider.player_id && other.official_player_id === manifest.sourceId);

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
    const { id, rider, session } = context(c);

    if (!sessions.current(id, identity)) throw new ApplicationError(401, 'Session changed. Sign in again.');

    if (runtime.world.active(rider.player_id))
      throw new ApplicationError(409, 'Finish the active ride before importing.');
    let stage: string;

    try {
      stage = imports.prepare(rider, files);
    } catch {
      throw new ApplicationError(400, 'Could not import these files. Select valid rider data and retry.');
    }

    if (session.pendingImport) imports.cancel(rider, session.pendingImport);
    session.pendingImport = stage;

    return c.json({ review: review(c) });
  }

  app.get('/api/me/export', (c) => {
    const { rider } = context(c);

    return c.json({
      filenames: Object.values(DownloadFile).filter((name) => runtime.services.documents.has(rider.player_id, name)),
    });
  });
  app.get('/api/me/export/:filename', (c) => {
    const { rider } = context(c);
    const filename = z.enum(DownloadFile).parse(c.req.param('filename'));
    const data = runtime.services.documents.get(rider.player_id, filename);

    if (!data) throw new ApplicationError(404, 'File not found.');

    return c.body(new Uint8Array(data), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  });
  app.post('/api/me/power-curves', async (c) => {
    const { rider } = context(c);
    const input = z.object({ confirm: z.literal(true), create: z.boolean() }).parse(await c.req.json());

    if (input.create) runtime.services.activities.rebuildPowerCurves(rider.player_id);
    else runtime.services.integrations.deletePowerCurve(rider.player_id);

    return c.json({ message: input.create ? 'Power curves rebuild queued.' : 'Power curves deleted.' });
  });

  app.get('/api/me/import', (c) => {
    context(c);

    return c.json({ filenames: importFilenameSchema.options, review: review(c) });
  });
  app.post('/api/me/import', async (c) => {
    const { rider } = context(c);
    const identity = accounts.identityOf(rider);
    const form = await c.req.parseBody();
    const files: ImportFiles = {};

    for (const name of importFilenameSchema.options) {
      const upload = form[name];

      if (upload instanceof File && upload.name) files[name] = new Uint8Array(await upload.arrayBuffer());
    }

    return stageFiles(c, identity, files);
  });
  app.post('/api/me/import/confirm', async (c) => {
    const input = z
      .strictObject({
        stage: z.string(),
        cancel: z.boolean().default(false),
        keepName: z.boolean().default(false),
        confirmSource: z.boolean().default(false),
      })
      .parse(await c.req.json());

    const { rider, session } = context(c);
    const current = review(c);

    if (!current || current.stage !== input.stage)
      throw new ApplicationError(409, 'The import changed. Reload and review it again.');

    if (input.cancel) imports.cancel(rider, current.stage);
    else {
      if (current.confirmSource && !input.confirmSource)
        throw new ApplicationError(400, 'Confirm the import source first.');

      if (runtime.world.active(rider.player_id))
        throw new ApplicationError(409, 'Finish the active ride before importing.');
      imports.publish(rider, current.stage, input.keepName);
    }

    delete session.pendingImport;

    return c.json({ rider: management.publicRider(accounts.get(rider.player_id)!), review: null });
  });

  function connection(c: Context<WebEnv>) {
    const { rider } = context(c);
    const resolved = settings.resolveRiderSettings(runtime.config.riderDefaults, settings.read(rider.player_id));

    return c.json({
      connected: connections.has(rider.player_id, 'zwift'),
      upload: resolved.uploads.zwift.enabled,
      click: resolved.devices.zwiftClick.enabled,
    });
  }

  app.get('/api/me/zwift', connection);
  app.put('/api/me/zwift', async (c) => {
    const input = z
      .strictObject({
        username: z.string().max(500),
        password: z.string().max(1000),
        upload: z.boolean(),
        click: z.boolean(),
      })
      .parse(await c.req.json());

    const { rider } = context(c);
    const username = input.username.trim();

    if (Boolean(username) !== Boolean(input.password))
      throw new ApplicationError(400, 'Enter both username and password.');

    if (!username && !connections.has(rider.player_id, 'zwift') && (input.upload || input.click))
      throw new ApplicationError(400, 'Save credentials before enabling uploads or Click.');

    if (username) connections.save(rider.player_id, 'zwift', [username, input.password]);
    settings.save(rider.player_id, {
      ...settings.read(rider.player_id),
      'uploads.zwift.enabled': input.upload,
      'devices.zwiftClick.enabled': input.click,
    });

    return connection(c);
  });
  app.delete('/api/me/zwift', (c) => {
    const { rider } = context(c);
    runtime.services.uploads.disconnect(rider.player_id, 'zwift_credentials.bin');

    return connection(c);
  });
  app.post('/api/me/zwift/import', async (c) => {
    const input = z.strictObject({ profile: z.boolean(), achievements: z.boolean() }).parse(await c.req.json());
    const { rider } = context(c);
    const identity = accounts.identityOf(rider);
    const credentials = connections.read(rider.player_id, 'zwift');

    if (!credentials || (!input.profile && !input.achievements))
      throw new ApplicationError(400, 'Save credentials and choose at least one download.');

    if (runtime.world.active(rider.player_id))
      throw new ApplicationError(409, 'Finish the active ride before importing.');
    let files: ImportFiles;

    try {
      files = await integrations.downloadOfficialData(
        credentials[0],
        credentials[1],
        input.profile,
        input.achievements,
      );
    } catch {
      throw new ApplicationError(400, 'Download failed. Existing rider data was retained.');
    }

    return stageFiles(c, identity, files);
  });
}
