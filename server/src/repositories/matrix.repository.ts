import type { RepositoryContext as Runtime } from '#src/context';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { parse } from 'ini';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

export interface MatrixHandlers {
  receive(author: string, content: string): void;
  onlineCount(): number;
  encrypted(): void;
  connectionFailed(): void;
  loginFailed(): void;
}

export interface MatrixTransport {
  send(content: string): Promise<void>;
  presence(count: number): void;
  close(): Promise<void>;
}

class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string,
  ) {
    super(`Matrix request failed: ${status} ${errcode}`);
  }
}

const session = z.object({
  homeserver: z.string(),
  userId: z.string(),
  deviceId: z.string(),
  accessToken: z.string(),
});

const event = z.object({
  type: z.string(),
  sender: z.string().default(''),
  state_key: z.string().optional(),
  content: z.record(z.string(), z.unknown()).default({}),
});

const sync = z.object({
  next_batch: z.string(),
  rooms: z
    .object({
      join: z
        .record(
          z.string(),
          z.object({
            state: z.object({ events: z.array(event) }).optional(),
            timeline: z.object({ events: z.array(event) }).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const text = z.object({
  msgtype: z.literal('m.text'),
  body: z.string().min(1),
  // Edits repeat the message with a "* " prefix; relaying them would duplicate chat.
  'm.relates_to': z.object({ rel_type: z.string().optional() }).optional(),
});

const member = z.object({ displayname: z.string().min(1).nullish() });

const whoami = z.object({ user_id: z.string() });

type MatrixBody = Record<string, z.infer<ReturnType<typeof z.json>>>;

function localpart(user: string) {
  return user.replace(/^@/, '').replace(/:.*$/, '');
}

export class MatrixRepository {
  openMatrixTransport(
    settings: Runtime['config']['integrations']['matrix'],
    storageDir: string,
    handlers: MatrixHandlers,
  ) {
    const credentials = z
      .object({
        matrix: z.union([z.object({ access_token: z.string().min(1) }), z.object({ password: z.string().min(1) })]),
      })
      .parse(parse(readFileSync(settings.credentialsFile, 'utf8'))).matrix;

    const homeserver = settings.homeserver.replace(/\/+$/, '');
    const sessionFile = resolve(storageDir, 'matrix-session.json');
    const closing = new AbortController();
    const names = new Map<string, string>();
    let token = 'access_token' in credentials ? credentials.access_token : '';
    let userId = '';
    let room = '';
    // Set after the first sync, once the room's encryption state is known.
    let connected = false;
    let encrypted = false;
    let warned = false;

    const request = async <T extends z.ZodType>(
      schema: T,
      method: string,
      path: string,
      body?: MatrixBody,
      timeout = 30_000,
    ): Promise<z.output<T>> => {
      const response = await fetch(`${homeserver}/_matrix/client/v3${path}`, {
        method,
        headers: {
          ...(token && { Authorization: `Bearer ${token}` }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.any([closing.signal, AbortSignal.timeout(timeout)]),
      });

      if (!response.ok) {
        const error = z
          .object({ errcode: z.string() })
          .catch({ errcode: '' })
          .parse(await response.json().catch(() => ({})));

        throw new MatrixError(response.status, error.errcode);
      }

      return schema.parse(await response.json());
    };

    const restore = () => {
      let saved;

      try {
        saved = session.parse(JSON.parse(readFileSync(sessionFile, 'utf8')));
      } catch {
        return;
      }

      if (saved.homeserver === homeserver && localpart(saved.userId) === localpart(settings.user)) return saved;
    };

    const identify = async () => {
      const response = await request(whoami, 'GET', '/account/whoami');

      userId = response.user_id;
    };

    // A stored session keeps one device; logging in on every start would add a new device each time.
    const login = async () => {
      if (!('password' in credentials)) {
        await identify();

        return;
      }

      const saved = restore();

      if (saved) {
        token = saved.accessToken;

        try {
          await identify();

          return;
        } catch (error) {
          if (!(error instanceof MatrixError && error.status === 401)) throw error;
          rmSync(sessionFile, { force: true });
        }
      }

      token = '';

      const response = await request(
        z.object({ user_id: z.string(), device_id: z.string(), access_token: z.string() }),
        'POST',
        '/login',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: settings.user },
          password: credentials.password,
          initial_device_display_name: 'Zluggish',
          ...(saved && { device_id: saved.deviceId }),
        },
      );

      token = response.access_token;
      userId = response.user_id;
      new AssetFiles().writeDurable(
        sessionFile,
        JSON.stringify({
          homeserver,
          userId,
          deviceId: response.device_id,
          accessToken: token,
        } satisfies z.infer<typeof session>),
        true,
      );
    };

    const poll = async (since: string) => {
      const query = new URLSearchParams({
        // Filters only accept room IDs, so this follows the join that resolves an alias.
        filter: JSON.stringify({
          presence: { not_types: ['*'] },
          account_data: { not_types: ['*'] },
          room: {
            rooms: [room],
            account_data: { not_types: ['*'] },
            ephemeral: { not_types: ['*'] },
            state: { lazy_load_members: true },
            timeline: { limit: 50 },
          },
        }),
        timeout: since ? '30000' : '0',
      });

      if (since) query.set('since', since);
      const response = await request(sync, 'GET', `/sync?${query}`, undefined, 60_000);
      const joined = response.rooms?.join?.[room];

      for (const item of [...(joined?.state?.events ?? []), ...(joined?.timeline?.events ?? [])]) {
        if (item.type === 'm.room.member' && item.state_key) {
          const name = member.safeParse(item.content).data?.displayname;

          if (name) names.set(item.state_key, name);
          else names.delete(item.state_key);
        } else if (item.type === 'm.room.encryption' || item.type === 'm.room.encrypted') encrypted = true;

        // The first sync replays history; only newer messages are chat.
        if (!since || item.type !== 'm.room.message' || item.sender === userId) continue;
        const message = text.safeParse(item.content);

        if (message.success && message.data['m.relates_to']?.rel_type !== 'm.replace')
          handlers.receive(names.get(item.sender) ?? localpart(item.sender), message.data.body);
      }

      if (encrypted && !warned) {
        warned = true;
        handlers.encrypted();
      }

      return response.next_batch;
    };

    const presence = (count: number) => {
      if (!connected) return;
      // Many homeservers disable presence; a refused update changes nothing for riders.
      void request(z.unknown(), 'PUT', `/presence/${encodeURIComponent(userId)}/status`, {
        presence: 'online',
        status_msg: count ? `${count} rider${count === 1 ? '' : 's'} online` : 'No riders online',
      }).catch(() => {});
    };

    const run = async () => {
      while (!closing.signal.aborted) {
        let authenticated = false;

        try {
          await login();
          authenticated = true;

          // Joining also accepts an invite and resolves a room alias.
          const joined = await request(
            z.object({ room_id: z.string() }),
            'POST',
            `/join/${encodeURIComponent(settings.room)}`,
            {},
          );

          room = joined.room_id;
          let since = await poll('');
          connected = true;
          presence(handlers.onlineCount());

          while (!closing.signal.aborted) since = await poll(since);
        } catch (error) {
          connected = false;

          if (closing.signal.aborted) return;

          if (!authenticated && error instanceof MatrixError && (error.status === 401 || error.status === 403))
            handlers.loginFailed();
          else handlers.connectionFailed();
          await sleep(30_000, undefined, { signal: closing.signal }).catch(() => {});
        }
      }
    };

    const running = run();

    return {
      send: async (content) => {
        if (!connected) throw new Error('Matrix is not connected');

        // The bridge has no end-to-end encryption, so it never posts plain text into an encrypted room.
        if (encrypted) throw new Error('Matrix room is encrypted');

        await request(
          z.unknown(),
          'PUT',
          `/rooms/${encodeURIComponent(room)}/send/m.room.message/${new CryptoRepository().randomUUID()}`,
          { msgtype: 'm.text', body: content },
        );
      },
      presence,
      close: async () => {
        closing.abort();
        await running;
      },
    } satisfies MatrixTransport;
  }
}
