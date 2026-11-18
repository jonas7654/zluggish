---
sidebar_position: 1
description: Connect the in-game chat to a Discord channel.
---

# Discord bridge

The Discord bridge runs in the Zluggish server, also in Docker. It connects the in-game chat to one Discord channel.

The bridge supports:

- Chat in the configured channel.
- Welcome messages, and announcements when riders join or leave.
- Online presence.
- The commands `!online`, `!ping` and `!help`.

Live gateway and webhook delivery are not fully verified with a test guild yet.

## Set up the bridge

1. Make a Discord bot. Turn on the **Server Members Intent** and the **Message Content Intent** for the bot.
2. Make a private file `storage/discord.cfg`:

   ```ini
   [discord]
   token = YOUR_BOT_TOKEN
   webhook = YOUR_CHANNEL_WEBHOOK_URL
   ```

3. Add the bridge to `zluggish.config.ts`. The `credentialsFile` path is relative to the config file. This example is for `examples/zluggish.config.ts`:

   ```ts
   import { defineConfig } from 'zluggish/config';

   export default defineConfig({
     integrations: {
       discord: {
         enabled: true,
         credentialsFile: '../storage/discord.cfg',
         channel: '123456789012345678', // Replace with your channel ID.
         welcomeMessage: 'Welcome!',
         helpMessage: 'Ride with us on the local server.',
         announcePlayers: true,
       },
     },
   });
   ```

4. Start the server again.

:::warning

Keep the bot token and the webhook URL private.

:::

You can use the Discord bridge and the [Matrix bridge](matrix.md) at the same time.
