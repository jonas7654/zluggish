# Activity completion and deliveries

## Completion

Finishing an activity is one database transaction. It commits the activity row, the canonical FIT payload in `activity.fit`, the streak progression, the completion record, the delivery records and the jobs that publish optional artifacts. A failure commits none of them; the rider can save again.

Repeating the same completed save returns success without another streak contribution, power curve or delivery. Completed activities are immutable: a changed payload or FIT payload returns HTTP 409. The completion record holds the activity without its FIT bytes. `activity.fit` is the only stored FIT copy.

After the commit, jobs compute the power curve and the chart in the FIT worker thread and write the FIT export. Export files and charts are replaceable copies: deleting them breaks no download, delivery or detail view, and a job creates them again. The ghost recording is written from memory after the commit, off the main thread; a crash before that write loses only the recording.

Deleting an activity removes its rows in one transaction with a cleanup job; the job removes its chart, export, image and media files. Deletion does not reverse historical streak or power-curve contributions.

## Deliveries

Each provider delivery has a record, separate from the completion:

| State       | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `pending`   | Waits for its delivery job.                                                                                  |
| `sending`   | The request may be in flight. Committed before the provider request.                                         |
| `sent`      | The provider confirmed the delivery.                                                                         |
| `failed`    | The provider rejected the request, or it was never sent. Retry from rider home.                              |
| `ambiguous` | The result is unknown: a timeout, a reset or lost response, a server error, or a process stop while sending. |
| `cancelled` | The rider disconnected the provider, or an operator cancelled the delivery.                                  |

At startup, every `sending` delivery becomes `ambiguous`. An ambiguous delivery is never retried automatically: the provider may already hold the activity. Rider home offers a separate retry that includes ambiguous deliveries, with a duplicate warning.

Credentials and consent are checked in the transaction that commits `sending`. Only the attempt that committed `sending` records its result, so an attempt whose job lease expired cannot be sent again by a replacement job: the replacement records the delivery as `ambiguous` instead.

The Zwift delivery creates the official activity, then uploads its FIT data. The remote identifier is stored before the upload. A retry uploads to the stored activity and never creates a second one because only the upload failed.

### Provider duplicate behavior

Automatic retry of ambiguous deliveries is allowed only for a provider that reliably rejects duplicates or accepts an idempotency key. No provider is verified against the live service yet, so automatic retry is off for all of them (`automaticAmbiguousRetry` in `uploads.service.ts`).

| Provider                | Duplicate behavior                                                             | Source                                            | Automatic retry |
| ----------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- | --------------- |
| Garmin                  | Rejects a duplicate import with HTTP 409; Zluggish records 409 as `sent`.      | garminconnect-js documentation; not verified live | No              |
| Strava (API)            | Detects duplicates while processing the upload, after the request is accepted. | Not verified                                      | No              |
| Strava (session cookie) | Unknown.                                                                       | Not verified                                      | No              |
| Intervals.icu           | Unknown.                                                                       | Not verified                                      | No              |
| Runalyze                | Unknown.                                                                       | Not verified                                      | No              |
| Zwift                   | Accepts duplicates; the stored remote identifier prevents a second activity.   | Code review                                       | No              |

## Upload pause

`zluggish storage restore` sets a persistent upload pause in the restored database: a delivery can succeed after its backup was made. While the pause is set, no delivery job runs. Review the waiting deliveries with `zluggish uploads list`, cancel unwanted ones with `zluggish uploads cancel --activity ID --provider NAME`, then run `zluggish uploads resume --confirm`.

A manual directory copy cannot identify itself as a restore. After a manual restore, run `zluggish uploads pause` before the first server start.
