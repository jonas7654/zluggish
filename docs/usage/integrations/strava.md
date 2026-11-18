---
sidebar_position: 1
description: Upload Zluggish activities to Strava.
---

# Strava

Zluggish has two upload methods for Strava. Select one with **Upload method** under **Integrations → Strava**.

## API application

Strava controls access to its API. The rules for applications and accounts can change.

1. Get a client ID and a client secret in the [Strava API settings](https://www.strava.com/settings/api).
2. Set the **Authorization Callback Domain** to the host name of the web app. This is the host of `network.web.publicUrl`, or the address that you open the web app at.
3. In the web app, go to **Integrations → Strava**.
4. Save the client ID and the client secret.
5. Select **Authorize**.

Zluggish uses an existing `storage/<local-player-id>/strava_token.txt` file.

## Browser session cookie

1. Sign in to Strava in a browser.
2. Open the developer tools of the browser.
3. Go to **Application** or **Storage**, then **Cookies**.
4. Copy the value of `_strava4_session`.
5. In the web app, go to **Integrations → Strava** and paste the value into **Strava session cookie**.
6. Select the session cookie upload method.
7. Select **Test session**.

:::warning

The session cookie gives access to your Strava account. Keep it private, like a password.

:::

Screenshot upload uses the session cookie method, not the API.
