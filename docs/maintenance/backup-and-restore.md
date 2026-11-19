---
sidebar_position: 4
description: Back up and restore the Zluggish storage.
---

# Back up and restore

## Automatic and on-demand backups

Zluggish makes a backup every night at 02:00 UTC while the server is running. It keeps the 10 most recent nightly `.tar.gz` backups under `backups/`, next to `storage/`.

To create a backup at any time, sign in as an administrator and select **Manage → Server → Backups → Create backup**. The page shows when the backup finishes and where it was saved. Manual backups remain until you remove them.

When Zluggish migrates legacy data, it also saves a snapshot of the original storage to the same backup directory before making changes. See [Migrate from zwift-offline](migrating.md) for rollback instructions.

## Back up with the CLI

Stop the server before running the [storage command](../reference/cli/storage.md).

```sh
node server/dist/src/cli/bin.js --storage-dir ./storage storage backup --output ./backups/zluggish-2026-11-16.tar.gz
```

Nightly and manual backups are gzip-compressed tar archives. Use a `.tar.gz` output path to create an archive with the CLI. The restore command also accepts older backup directories. Creating and restoring archives requires `tar`, which is available in the Docker image. They contain a consistent SQLite snapshot, copies of the storage files such as media and FIT exports, the selected config when available, and a checksum manifest.

## Restore

1. Stop the server.
2. Restore the backup:

   ```sh
   node server/dist/src/cli/bin.js --storage-dir ./storage storage restore --input ./backups/zluggish-2026-11-16.tar.gz
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
