# Upgrade accounts

1. Stop the server. Make a storage backup with `zluggish storage backup` before the upgrade.
2. Install the new release. Keep the complete storage directory, including its keys.
3. Start the server. The versioned migration preserves player IDs, Argon2id password hashes, profiles, settings, and activities. It clears old relay keys. Riders must sign in again.
4. Open the setup address shown in the console. Copy the setup key from the console.
5. Select **Use an existing rider** if that rider has a password. Otherwise select **Create a new rider**.
6. Open **Manage**. Filter for **No password**. Set a password for each rider. Imported Werkzeug passwords cannot be used.
7. Give riders their login names and new passwords.

All existing riders start enabled with the rider role. The old `is_admin` flag gives no administrator role. Game app registration and server controls have been removed. Use the web app to create riders and control the server.

Setup stays complete after restart or restore. A restore does not restore web sessions or a disabled rider's ride completion permission. For a lost administrator, use [offline recovery](recovery.md).
