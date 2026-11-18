---
sidebar_position: 1
description: Set up a Windows computer to ride on your Zluggish server.
---

# Windows

This procedure redirects Zwift to Zluggish. It also makes Windows and Zwift accept the self-signed Zluggish certificate for the Zwift domain names. You can make your own certificates and use them in the same way.

:::tip

The **configure_client** script on the [zoffline-helper release page](https://github.com/oldnapalm/zoffline-helper/releases/latest) can do these steps for you.

:::

## Set up the client

1. Install Zwift, if it is not installed.
2. Download these two files to a known directory on the Windows computer:
   - [cert-zwift-com.p12](https://github.com/zluggish/zluggish/raw/main/assets/ssl/cert-zwift-com.p12)
   - [cert-zwift-com.pem](https://github.com/zluggish/zluggish/raw/main/assets/ssl/cert-zwift-com.pem)
3. Open Command Prompt as an administrator.
4. Go to the directory with the two files.
5. Import the certificate:

   ```bat
   certutil.exe -importpfx Root cert-zwift-com.p12
   ```

6. If the command asks for a password, leave it empty. The file has no password.
7. Open Notepad as an administrator.
8. Open `C:\Program Files (x86)\Zwift\data\cacert.pem`.
9. Add the contents of `cert-zwift-com.pem` to the end of `cacert.pem`, then save the file.
10. In Notepad, open `C:\Windows\System32\Drivers\etc\hosts`.
11. Add this line to the end of the file. Replace `<server-ip>` with the IP address of the Zluggish server:

    ```text
    <server-ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com launcher.zwift.com
    ```

12. Save the file.

If Zluggish and Zwift run on the same computer, use `127.0.0.1` as the IP address.

## Helper scripts

The repository has two helper scripts in [`scripts/`](https://github.com/zluggish/zluggish/tree/main/scripts):

- `configure_client.bat` redirects the client to `127.0.0.1`. For a server on a different computer, use the manual steps.
- `launch.bat` redirects the client to the address in `scripts/ip_address.txt` and starts Zwift. When you continue after its pause, it restores the hosts file. It does not start the server.

## Next step

Start Zwift, select your user and sign in. To stop using Zluggish, see [Uninstall](../../maintenance/uninstall.md).
