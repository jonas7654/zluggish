---
sidebar_position: 2
description: Connect the in-game chat to a Matrix room. Experimental.
---

# Matrix bridge

:::warning[Experimental]

The Matrix bridge is experimental. It is not verified with a live homeserver yet.

:::

The Matrix bridge runs in the Zluggish server, also in Docker. It connects the in-game chat to one Matrix room. You can use it at the same time as the [Discord bridge](discord.md).

- Room messages go to the riders in the game.
- In-game chat goes to the room as `Name: message`.
- The bot answers `!online`, `!ping` and `!help` in the room.

## Set up the bridge

1. Make a private file `storage/matrix.cfg` with the password of the bot:

   ```ini
   [matrix]
   password = YOUR_BOT_PASSWORD
   ```

   If the homeserver does not allow password login, use an access token for the bot:

   ```ini
   [matrix]
   access_token = YOUR_BOT_ACCESS_TOKEN
   ```

2. Add the bridge to `zluggish.config.ts`. The `credentialsFile` path is relative to the config file. This example is for `examples/zluggish.config.ts`:

   ```ts
   import { defineConfig } from 'zluggish/config';

   export default defineConfig({
     integrations: {
       matrix: {
         enabled: true,
         credentialsFile: '../storage/matrix.cfg',
         homeserver: 'https://matrix.example.org',
         user: '@zluggish:matrix.example.org',
         room: '#ride:matrix.example.org', // A room alias or a room ID such as '!abc123:matrix.example.org'.
         helpMessage: 'Commands: !online, !ping, !help. Other messages are relayed to riders in-game.',
         announcePlayers: true,
       },
     },
   });
   ```

3. Make sure that the bot can join the room. The bot must be a member or have an invitation, or the room must be public.
4. Start the server again. The bot joins the room when the server starts.

## Settings

- `homeserver` is the URL of the client-server API. Zluggish does not follow `.well-known` delegation. Use the URL that your Matrix client connects to.
- `room` is a room alias or a room ID.

## Limits

- Encrypted rooms are not supported. The bridge writes a warning to the log and does not post into an encrypted room.
- After a password login, the server keeps the session in `storage/matrix-session.json`. Then a restart uses the same device. Keep this file private.
