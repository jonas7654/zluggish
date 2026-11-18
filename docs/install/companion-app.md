---
sidebar_position: 5
description: Use the Zwift Companion app with Zluggish on a non-rooted Android device.
---

# Zwift Companion app

This procedure is for a non-rooted Android device.

1. Download and install the patched APK from the [zoffline-companion releases](https://github.com/fatsbrown/zoffline-companion/releases/latest). You can also [patch it yourself](https://github.com/fatsbrown/zoffline-companion#patch-it-yourself).
2. Download and install `app-Github-release.apk` from the [Virtual Hosts releases](https://github.com/x-falcon/Virtual-Hosts/releases/latest).
3. Make a file with the name `hosts.txt` on the device. Replace `<server-ip>` with the IP address of the Zluggish server:

   ```text
   <server-ip> us-or-rly101.zwift.com
   <server-ip> secure.zwift.com
   ```

4. In the Android settings, turn off **Private DNS**.
5. Open Virtual Hosts and select `hosts.txt`.

:::warning

Do not add `cdn.zwift.com` to `hosts.txt`. Companion downloads images from the official server.

:::

Instead of Virtual Hosts, you can set `dns.enabled` to `true` in `zluggish.config.ts`. Then set **DNS 1** of the phone's Wi-Fi connection to the IP address of the Zluggish server. If your router can change DNS records, you can also set the records on the router.
