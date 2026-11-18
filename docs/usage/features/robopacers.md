---
sidebar_position: 3
description: Ride with RoboPacers made from recorded rides.
---

# RoboPacers

A RoboPacer is a ghost that you record with a power simulator. The [zoffline-bots repository](https://github.com/oldnapalm/zoffline-bots) has some RoboPacers.

## Requirements for a RoboPacer

- Record the ghost with an update interval of 1 second. The default interval is 3 seconds.
- Start and finish the activity at the same position and speed. If not, the bot does not loop smoothly.
- The profile must have a unique player ID and the route ID. Then a rider who joins the bot takes the same turns at intersections.

## Add a RoboPacer

1. Make a folder `storage/robopacers/<pacer-name>/`.
2. Put the `profile.bin` and `route.bin` files of the pacer in that folder.

The old Python `bot_editor.py` helper is not included. Use a compatible recording, or other tools, to set its ID, route and loop.

## Dynamic RoboPacers

A dynamic RoboPacer increases its power on climbs and decreases it on descents. To record one, use [standalone_power.py](https://github.com/oldnapalm/zwift-offline/blob/master/standalone_power.py). It needs two ANT sticks, [python-ant](https://github.com/mch/python-ant) and [PowerMeterTx.py](https://github.com/oldnapalm/zwift-offline/blob/master/PowerMeterTx.py).

To ride in a group behind a RoboPacer, see [Pelotons](pelotons.md).
