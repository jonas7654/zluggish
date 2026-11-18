import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { Hono } from 'hono';

export function integrationRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const connections = runtime.services.connections;

  app.post('/api/d-lock-service/device/authenticate', async (c) => {
    const rider = authenticated(c);
    const { credentials } = connections.inspect(rider.player_id, 'zwift');

    const enabled = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(rider.player_id),
    ).devices.zwiftClick.enabled;

    if (!enabled || !credentials) return c.body(null, 204);

    try {
      const token = await runtime.services.integrations.officialLogin(credentials[0], credentials[1]);

      const response = await runtime.services.integrations.request(
        `${runtime.services.integrations.officialRelay}/api/d-lock-service/device/authenticate`,
        {
          method: 'POST',
          headers: {
            ...runtime.services.integrations.officialHeaders(token),
            'Content-Type': c.req.header('Content-Type') ?? 'application/octet-stream',
            Accept: c.req.header('Accept') ?? '*/*',
          },
          body: new Uint8Array(await c.req.arrayBuffer()),
          signal: AbortSignal.timeout(30_000),
        },
      );

      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
        },
      });
    } catch {
      return c.body(null, 204);
    }
  });
}
