# Recover access

## Lost setup key

1. Find the terminal where the server runs. For Docker, run `docker compose logs zluggish`.
2. If you cannot find the key, restart the server before setup is complete.
3. Use the new key shown in the console. The old key no longer works.

The key is not in the database or configuration. A completed setup never opens again.

## Forgotten administrator password or no enabled administrator

1. Stop the server. The CLI requires the exclusive storage lock.
2. Put the new password in a private file.
3. Run `zluggish accounts recover --user ID --password-file PATH --admin`. Select the correct storage directory with `--storage-dir PATH` when necessary.
4. Delete the password file.
5. Start the server. Sign in to the web app. Confirm the password to open **Manage**.

`--admin` sets a password, enables the rider, gives the administrator role, and completes unclaimed setup in one transaction. It revokes old credentials. It never reopens setup. Without `--admin`, recovery preserves the enabled state and role.

Use this procedure after restoring a backup with complete setup and no enabled administrator. Do not delete the setup state to recover access.
