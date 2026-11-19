---
sidebar_position: 3
description: Set up a Mac to ride on your Zluggish server.
---

# macOS

This procedure makes macOS and Zwift trust the [server certificate](../certificate.md) and redirects Zwift to Zluggish. There is no setup script for macOS yet.

## Set up the client

1. Install Zwift, if it is not installed.
2. Sign in to the Zluggish web app and select **Install** in the menu. Under **Check the certificate**, download the certificate as `.crt`.
3. Open Keychain Access.
4. Under **Keychains**, select **System**. Under **Category**, select **Certificates**.
5. Select **File → Import Items…** and import the `.crt` file.
6. Right-click **\*.zwift.com** and select **Get Info**.
7. Under **Trust**, set **When using this certificate** to **Always Trust**.
8. In Terminal, go to the directory with the `.crt` file.
9. Add the certificate to the Zwift certificate file:

   ```sh
   cat zluggish-zwift-*.crt >> ~/Library/Application\ Support/Zwift/data/cacert.pem
   ```

10. Open `/etc/hosts` in a text editor with administrator rights.
11. Add this line to the end of the file. Replace `<server-ip>` with the IP address of the Zluggish server:

    ```text
    <server-ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com launcher.zwift.com
    ```

12. Save the file.

If Zluggish and Zwift run on the same computer, use `127.0.0.1` as the IP address.

## Next step

Start Zwift, select your user and sign in. To stop using Zluggish, see [Uninstall](../../maintenance/uninstall.md).
