# Account security implementation notes

The web listener is a separate route table. It never registers game routes. The game listeners never register web management routes. Only opaque IDs in the web session store identify a web rider. Authorization reloads the account, enabled state, and role. Management confirmation has an absolute 900,000 ms deadline.

## Native completion allowlist

The current game API creates activities with `POST /api/profiles/:id/activities`. The server records the activity ID, bearer digest, relay generation, and relay key during that request. An activity created after disable cannot register.

Only these requests can use a disabled rider's in-memory permission:

| Method and path                                   | Purpose                                        | Binding                                                                               |
| ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PUT /api/profiles/:id/activities/:activityId`    | Save an activity, including embedded FIT bytes | Captured player ID, activity ID in path and protobuf, bearer digest, relay generation |
| Same PUT with `upload-to-strava=true`             | Finish or discard a zero-distance activity     | Same bindings; retain a five-minute final response receipt                            |
| `DELETE /api/profiles/:id/activities/:activityId` | Discard the captured activity                  | Captured IDs and bearer digest                                                        |

The native activity protobuf carries FIT bytes. This implementation grants no general upload, media, profile, or `/api/*` exception. Companion requests cannot use it. A final retry with different bytes is rejected. The permission and receipt do not survive restart. Normal relay restoration requires an enabled account and a persisted matching auth version.

## Settings storage inventory

| Setting                                                                       | Storage and validation                                    | Secret                                     | Application                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| Rider ghosts, upload consent and method, device consent, TrainingPeaks folder | `rider_settings.value`, `overrideSchema`                  | No                                         | Next use; no restart                              |
| World overrides                                                               | Existing `world_settings.value`, current world validation | No                                         | Existing simulation reload behavior               |
| Network, server configuration, rider defaults                                 | Operator TypeScript configuration, `configSchema`         | Configuration may contain paths to secrets | Browser read-only; restart after operator changes |
| Integration credentials                                                       | Existing encrypted rider documents                        | Yes                                        | Remain in game app connection pages               |

Settings rows keep revisions, including empty override rows. Writes in the web app compare the expected revision. The game settings form submits its revision too. Offline and synchronous simulation writers increment revisions. Failed transactions do not publish cache values.

## Release checks that require equipment

Do not treat Chromium tests as real Zwift results. Before release:

1. Compare game app screenshots with the previous release on Windows and macOS.
2. Check rider selection, remembered sign-in, native handoff, token refresh, and own settings in both real Zwift launchers.
3. Disable a connected rider on both real game clients. Check native save and finish, including any client-required uploads. Extend the explicit allowlist only with traced requests and fixtures.
4. Check reconnect, the inactivity deadline, the absolute four-hour deadline, and loss of permission after server restart.
5. Check production packaging on both supported container architectures.

The web app currently shows operator configuration as read-only. The browser can edit persisted scalar world overrides and event descriptions or start times, and can delete events. Visual comparison remains release acceptance work. Keep these changes together until the first-release acceptance work is complete.
