---
sidebar_position: 2
description: Install the Zluggish server with Docker Compose.
---

# Install the server

If you use legacy zwift-offline now, do the steps in [Migrate from zwift-offline](../maintenance/migrating.md) first.

## Install with Docker Compose

1. Make an empty directory on the server, for example `/etc/zluggish`.
2. In that directory, make a file with the name `docker-compose.yml` and this content:

   ```yaml
   services:
     zluggish:
       image: ghcr.io/zluggish/zluggish:latest
       volumes:
         - /etc/localtime:/etc/localtime:ro
         - ./storage:/usr/src/app/zluggish/storage
       ports:
         - 80:80
         - 443:443
         - 8080:8080
         - 3024:3024/udp
         - 3025:3025
       restart: unless-stopped
   ```

3. Start the server from that directory:

   ```sh
   docker compose up -d
   ```

4. Look at the server output. Make sure that it shows this line:

   ```sh
   zluggish-1  | 2026-11-17T11:40:23.126Z INFO server.ready Zluggish is ready
   ```

The server makes the `storage` directory on the first start. This directory holds the configuration, the users and the activities.

The [ports reference](../reference/ports.md) tells what each port is for.

## Build from source

1. Clone the [repository](https://github.com/zluggish/zluggish).
2. From the repository root, run:

   ```sh
   docker compose -f docker/docker-compose.yml up --build
   ```

This setup uses the `storage` directory in the repository root.

## Next step

Do the [first-time setup](first-time-setup.md).
