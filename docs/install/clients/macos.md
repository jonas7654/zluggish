---
sidebar_position: 2
description: Set up a Mac to ride on your Zluggish server.
---

# macOS

This procedure redirects Zwift to Zluggish. It also makes macOS and Zwift accept the self-signed Zluggish certificate for the Zwift domain names. You can make your own certificates and use them in the same way.

## Set up the client

1. Install Zwift, if it is not installed.
2. Download [cert-zwift-com.pem](https://github.com/zluggish/zluggish/raw/main/assets/ssl/cert-zwift-com.pem) to a known directory on the Mac.
3. Open Keychain Access.
4. Under **Keychains**, select **System**. Under **Category**, select **Certificates**.
5. Select **File → Import Items…** and import `cert-zwift-com.pem`.
6. Right-click **\*.zwift.com** and select **Get Info**.
7. Under **Trust**, set **When using this certificate** to **Always Trust**.
8. In Terminal, go to the directory with `cert-zwift-com.pem`.
9. Add the certificate to the Zwift certificate file:

   ```sh
   sed -n '29,53p' cert-zwift-com.pem >> ~/Library/Application\ Support/Zwift/data/cacert.pem
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
