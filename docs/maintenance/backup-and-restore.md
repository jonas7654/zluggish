---
sidebar_position: 4
description: Back up and restore the Zluggish storage.
---

# Back up and restore

Use the CLI to back up and restore the storage. The CLI commands are in [Storage and upload commands](../reference/cli/storage.md).

Stop the server before you use these commands.

## Back up

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage storage backup --output /backups/zluggish-2026-11-16
```

The backup has the database (a consistent SQLite copy), media, FIT exports, charts, encryption keys and the selected config. It also has a checksum manifest.

## Restore

1. Stop the server.
2. Restore the backup:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage storage restore --input /backups/zluggish-2026-11-16
   ```

3. Show the deliveries that are not complete:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage uploads list
   ```

4. Look at each provider. Cancel the deliveries that the provider already has, with `uploads cancel`.
5. Allow the automatic deliveries again:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage uploads resume --confirm
   ```

6. Start the server.

A backup cannot know which deliveries the providers received after the backup. For this reason, a restore pauses the uploads.

## Copy the storage manually

If you copy the storage directory manually, pause the uploads before the first start:

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage uploads pause
```
