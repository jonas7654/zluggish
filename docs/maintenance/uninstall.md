---
sidebar_position: 5
description: Make Zwift use the official service again.
---

# Uninstall

To use the official Zwift service again:

1. Remove the Zluggish line from the `hosts` file, or make it a comment.
2. Close Zwift fully. On Windows, right-click the Zwift icon in the system tray and select exit.
3. Start Zwift.

On Android, turn off Virtual Hosts, or remove the DNS setting from the Wi-Fi connection.

To remove the server, stop the container with `docker compose down` in the directory with `docker-compose.yml`. The `storage` directory stays. Delete it only if you do not need your data.
