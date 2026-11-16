# Web app

Use Zluggish only on a network that you trust. Other devices on the network can read the passwords that riders type.

The game app and the web app use the same rider credentials. Each application has a separate sign-in. The administrator role gives access to **Manage** in the web app only. It gives no additional game or Companion permissions.

## Home network

The web app sends passwords over the home network without encryption. Do not forward port 8080 on the router to the internet.

1. Publish port `8080:8080` in Docker Compose.
2. Set `network.host` to `0.0.0.0` to accept home network connections. Set `network.web.host` to override the web bind address.
3. Open `http://<server-ip>:8080` on your computer or phone.
4. For first setup, open `/setup`. Copy the setup key from the server terminal, or run `docker compose logs zluggish`.
5. Create your rider. This rider receives the administrator role. Or select **Use an existing rider** and enter that rider's password.
6. Open **Manage**. Create the other riders with passwords.
7. Give each rider their login name and password. Riders use these credentials in the game app and the web app.

```yaml
services:
  zluggish:
    ports:
      - '8080:8080'
```

## Same computer only

1. Set `network.web.host` to `127.0.0.1` for a native installation.
2. For Docker, keep the container listener on `0.0.0.0`. Publish `127.0.0.1:8080:8080` instead of `8080:8080`.
3. Open `http://127.0.0.1:8080` on the server computer.

```yaml
services:
  zluggish:
    ports:
      - '127.0.0.1:8080:8080'
```

The web listener defaults to enabled on port 8080. Set `network.web.enabled` to `false` to stop it. The web port must differ from all game listener ports. Restart the server after changing listener configuration.

## My account

1. Enter your login name and password on **Sign in**. The page does not list riders.
2. Open **My settings** to change your rider preferences.
3. To change your password, enter the current password and the new password twice. Select **Save**.
4. Sign in again. The password change revokes previous sessions and tokens.

## Management

1. Sign in with an enabled rider that has the administrator role.
2. Select **Manage**. Enter your password again when requested.
3. Select a rider to edit their name or login name, set a password, change the role, disable, enable, or revoke sessions.
4. Select **Save** for an edit. If the revision changed, review the new server data before another save.

Password confirmation expires exactly 15 minutes after verification. Requests and activity do not extend it. Confirm again to continue. Failed requests keep the form draft. The orange edge and **Manage** marker identify management pages.

A rider with **No password** cannot sign in. Setting their password preserves their enabled state. Use **Enable** separately for a disabled rider. The last enabled administrator cannot be disabled or lose the role.

Disable blocks normal access immediately. An active ride captured at disable can save and finish for at most four hours. Inactivity can end this permission earlier. Restart ends it. Revoke sessions, password changes, role changes, and re-enable cancel this permission immediately and can lose unsaved progress. Re-enable restores no old credentials.

Server configuration values with no browser storage path are read-only. Stop the server and edit the configuration file to change them. The web app never writes TypeScript configuration.
