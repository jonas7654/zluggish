---
sidebar_position: 9
description: Get missing game assets from Zwift through the CDN proxy.
---

# CDN proxy

Zluggish serves the bundled files from `assets/cdn/`. The proxy can get missing game assets from Zwift.

Set `proxy.mode` in `zluggish.config.ts` to one of these values:

| Value        | Result                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------- |
| `'auto'`     | The default. Get missing assets from Zwift. If Zwift does not answer, the asset is not found. |
| `'enabled'`  | Get missing assets from Zwift. If Zwift does not answer, the request fails with an error.     |
| `'disabled'` | Use only local assets.                                                                        |

To find the Zwift servers, the proxy uses Google public DNS. It does not use the host redirects of the client.

Live proxy behavior is part of the manual verification.

The old `get_gameassets.py` downloader is not included. Keep an existing asset cache in the new CDN asset directory. Build the image again after you change the bundled files.
