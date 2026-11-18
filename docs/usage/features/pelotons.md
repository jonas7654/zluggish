---
sidebar_position: 4
description: Ride in a group of bots behind a RoboPacer.
---

# Pelotons

A peloton is one [RoboPacer](robopacers.md) with a group of follower bots. The followers ride in formation around and behind the pacer. When you join the pacer, it feels like a real group ride.

The followers move up and back in the group and drift to the sides. On climbs, the group stretches out and weaker riders lose some meters, then come back on the flat. On descents, the riders coast. Power, cadence and heart rate look realistic, including the effect of the draft.

## Start a peloton from the chat

1. Ride next to a RoboPacer.
2. Type `.peloton 20` in the chat to add 20 followers.

Type `.peloton` to show the current size. Type `.peloton off` to remove the peloton.

Chat changes are saved as overrides in SQLite. They do not change `zluggish.config.ts`.

## Configure a peloton

Add a `pelotons` array to `zluggish.config.ts`. Each entry needs a stable `id` and a `pacer`. The `pacer` is the folder name in `storage/robopacers`, or the player ID of the pacer. All other fields have default values.

```ts
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  pelotons: [
    {
      id: 'volcano-group',
      pacer: 'B - 3.3 WKG - Watopia - Volcano Climb',
      bots: 25,
      columns: 0,
      rowGap: 2.2,
      lateralSpacing: 65000,
      besidePacer: 2,
      dynamics: 1,
      shuffleInterval: 30,
      draft: 0.7,
      climbStretch: 1,
      maxDrop: 40,
      riders: [
        {
          firstName: 'Tadej',
          lastName: 'Pogacar',
          countryCode: 705,
          isMale: true,
          position: 'front',
          strength: 1.3,
        },
        {
          firstName: 'Ana',
          lastName: 'Lopez',
          isMale: false,
          weight: 55,
          position: 'back',
          strength: 0.85,
        },
      ],
    },
  ],
});
```

Start the server again after you change the config. The server does not monitor the file for changes.

## Peloton fields

| Field             | Meaning                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `bots`            | Number of followers, up to 200. Riders that are not in `riders` get random names and equipment.         |
| `columns`         | Maximum width of the group. `0` sets the width automatically.                                           |
| `rowGap`          | Distance between rows, in meters.                                                                       |
| `lateralSpacing`  | Distance between riders at the side, in `roadPosition` units. 100000 is 1 meter. The default is 0.65 m. |
| `besidePacer`     | Number of riders next to the pacer.                                                                     |
| `dynamics`        | `0` is a rigid formation, `1` is normal and `2` is very lively.                                         |
| `shuffleInterval` | Average time between position changes, in seconds.                                                      |
| `draft`           | Part of the power that a rider uses on a wheel.                                                         |
| `climbStretch`    | How much the group stretches on climbs.                                                                 |
| `maxDrop`         | How far a rider can drop back on a climb, in meters.                                                    |
| `enabled`         | Set to `false` to turn off the peloton but keep its configuration.                                      |
| `riders`          | Riders with fixed profiles. See [Rider fields](#rider-fields).                                          |

Random names come from the `bots.ridersFile` catalogue, if you set one.

### Rider fields

Each rider in `riders` uses camelCase profile fields, for example `firstName`, `lastName`, `countryCode`, `bikeFrame` and `rideJersey`. It also has these fields:

| Field          | Value                              |
| -------------- | ---------------------------------- |
| `position`     | `front`, `middle`, `back` or `any` |
| `strength`     | 0.5 to 1.5                         |
| `weight`       | Kilograms                          |
| `height`       | Centimeters                        |
| `cadence`      | Revolutions per minute             |
| `maxHeartRate` | Beats per minute                   |

Chat overrides stay in SQLite when you change the config.
