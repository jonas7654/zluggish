---
sidebar_position: 1
description: Ride with your previous efforts on the same route.
---

# Ghosts

Ghosts are on by default. To turn them on or off for your user, change **Ride with ghosts** in **Settings** in the web app.

When you save an activity, Zluggish saves its ghost in `storage/<player_id>/ghosts/<world>/<route>`. The next time that you ride the same route, the ghost rides with you.

To regroup the ghosts, type `.regroup` in the chat.

## Legacy ghost appearance

zwift-offline used `storage/ghost_profile.txt` for the ghost appearance. The migration keeps this path as `ghosts.profileFile`. Zluggish does not use this file yet. Ghosts use the profile of the local user.

The old `find_equip.py` helper is not included.
