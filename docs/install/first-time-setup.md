---
sidebar_position: 3
description: Make the first administrator with the setup key.
---

# First-time setup

To make the first administrator, you must show that you have access to the server. You do this with a setup key.

The server makes a new setup key at each start until you complete the setup. The key is in the **Zluggish first-time setup** block of the server output. The web app must be on. It is on by default.

:::warning

Keep the setup key private. A person with the key can make the first administrator.

:::

## Make the first administrator

1. Start the server.
2. Find the **Open:** address and the **Setup key:** in the server output. You can also show the container logs:

   ```sh
   docker compose logs zluggish
   ```

3. Open the setup address in a browser. The default address is `http://<server-ip>:8080/setup`.
4. Paste the key into **Setup key**.
5. Select **Check key**. Upper and lower case, spaces and hyphens are not important.
6. Wait until **Setup key accepted** shows.
7. Enter a name, a login name and a password for the new user.
8. Select **Complete setup**.

The user becomes the first administrator and the web app signs in that user. The setup key stops working. Use the login name and the password to sign in again.

If you migrate from zwift-offline, you can select **Use an existing user** in step 7. Select an enabled user that has a password, and enter the password of that user. A user without a password needs [account recovery with the CLI](../reference/cli/accounts.md#recover-a-local-account) first.

## Add the other users

1. Open **Manage → Users**.
2. Make the other users. Give each user a password.

Each rider selects their user in the game and signs in with the username and the password. Android uses native credential login, so each Android user must have a password.

## If the key does not work

- The key works only until the setup is complete or the server stops.
- If the server starts again before you complete the setup, use the new key from the latest server output.
- After the setup, the server does not make a new key. If you cannot get administrator access, use [account recovery with the CLI](../reference/cli/accounts.md#recover-a-local-account).

## Next steps

1. Look at the [server configuration](../reference/configuration.md).
2. Set up the client for [Windows](clients/windows.md), [macOS](clients/macos.md) or [Android](clients/android.md).
