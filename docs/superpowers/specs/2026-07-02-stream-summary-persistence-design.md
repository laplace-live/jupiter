# Stream Summary Persistence — Design

**Date:** 2026-07-02
**Status:** Approved (amended — see Amendment below)
**Component:** `laplace-jupiter`
**Supersedes:** the "No database, no persistence" decision in
`2026-06-20-stream-summary-design.md`

## Amendment (2026-07-02): missed-end revalidation descoped

After implementation, the revalidation subsystem (5-min post-restore silence
timer, `finalizeStale`, `endEstimated` flag/marker, `lastEventAt` tracking) was
judged not worth its complexity and removed. This reverses the earlier "never
lose a summary" choice:

- **New accepted limitation:** a stream that ends entirely while the bot is
  down produces **no summary**. Its restored session is kept but **unanchored**
  (`liveStartBound` cleared on restore of LIVE rooms), so the next stream's
  `live-start` *supersedes* it — stale data is silently dropped instead of
  merging two streams into one corrupted summary.
- Still-live streams across a restart, and rooms restored in the ENDING state
  (debounce re-armed), behave exactly as originally specified.
- A Redis-backed store was considered as an alternative simplification and
  rejected: the storage backend is the thinnest layer (~50 lines); the
  complexity lives in serialization + restore semantics, which any backend
  needs. Optional Redis would also drop persistence for no-Redis deployments
  and add an external dependency, while `bot-data/` is already volume-mounted.

Sections below describing revalidation, `endEstimated`, and `lastEventAt` are
retained for history but no longer current.

## Goal

In-progress stream-summary state must survive process restarts (service
upgrades, container replacement, crashes). Today the state lives only in RAM
inside `SessionManager`; any restart silently discards the whole in-progress
stream and no summary is ever sent for it.

Accepted tolerances (user decisions):

- **Crash-safe, cheap:** periodic snapshot; a hard crash may lose up to one
  flush interval (~10s) of stats.
- **Events during downtime are lost** — restored numbers are a lower bound.
- **Never lose a summary:** if the stream ended while the bot was down, still
  send a best-effort summary on startup, clearly labeled, rather than dropping
  it.
- **At-most-once delivery:** on a crash at the exact moment of sending, prefer
  losing that summary over sending it twice.

## Approach (chosen: full-state JSON snapshot)

Serialize the entire `SessionManager` state to a single JSON file in
`bot-data/` on a throttled cadence and at shutdown; rehydrate it on startup.
Rejected alternatives: `bun:sqlite` incremental tables (schema + upsert
machinery for a few KB of state) and append-only event log + replay (unbounded
growth, and contradicts the accepted event-loss tolerance).

## State & serialization (pure, in `src/streamSummary.ts`)

### `SessionStats` changes

- New tracked field **`lastEventAt`** — initialized to `startedAt`, bumped to
  `max(lastEventAt, event.timestampNormalized)` in `record()`. This is the
  best-effort end time for a stream that ends during downtime.
- **`snapshot(): SessionStatsSnapshot`** — plain-JSON object of every
  accumulator field (`startedAt`, `partial`, `liveStartBound`, `lastEventAt`,
  counters, maxes, sums, revenue fields), with the two `Map`s (`chatters`,
  `spenders`) serialized as entry arrays.
- **`static restore(snap: SessionStatsSnapshot): SessionStats`** — exact
  inverse. Round-trip invariant: `restore(snapshot()).finalize(t)` deep-equals
  `finalize(t)`.

### `SessionManager` changes

- **`snapshot(): ManagerSnapshot`** — all rooms' session snapshots plus
  `pendingEndAt` where set. Timers are never serialized; they are re-derived
  on restore.
- **`restore(snap: ManagerSnapshot): void`** — rehydrates sessions and re-arms
  timers (see Restore behavior). Called once at startup before bridges
  connect.
- New option **`revalidateMs`** (default `STREAM_SUMMARY_REVALIDATE_MS`,
  injectable for tests, like `debounceMs`).

### Snapshot file shape

```json
{
  "version": 1,
  "savedAt": 1751400000000,
  "rooms": [
    [100, {
      "pendingEndAt": null,
      "session": {
        "startedAt": 1751390000000,
        "partial": false,
        "liveStartBound": true,
        "lastEventAt": 1751399990000,
        "chats": 42,
        "chatters": [[1, { "name": "a", "count": 40 }], [2, { "name": "b", "count": 2 }]],
        "watchedMax": 250, "onlinePeak": 80, "onlineSum": 130, "onlineSamples": 2,
        "likesMax": 3000, "newFollows": 2,
        "giftCount": 2, "giftRevenue": 40,
        "scCount": 2, "scRevenue": 150,
        "guardCount": 2, "guardRevenue": 396,
        "spenders": [[3, { "name": "c", "total": 248 }]]
      }
    }]
  ]
}
```

`version` mismatch or unparseable content → log a warning, discard, start
fresh. `savedAt` is informational (logging/debugging only; no staleness cap —
see Edge cases).

## Persistence module (new `src/summaryPersistence.ts`)

Small I/O-only module so `streamSummary.ts` stays pure:

- **`load(): Promise<ManagerSnapshot | null>`** — read
  `bot-data/summary-state.json`; on missing file return `null` silently; on
  corrupt/unversioned content log a warning and return `null`.
- **`save(snap: ManagerSnapshot): Promise<void>`** — write
  `bot-data/summary-state.tmp` then atomically `rename()` over
  `bot-data/summary-state.json` (POSIX rename; no torn file on crash). Uses
  `Bun.file`/`Bun.write` for I/O and `node:fs/promises` `rename` (no Bun
  equivalent).

`bot-data/` already exists at startup, is gitignored, and already holds
persistent state (the mtcute session), so it is the natural volume-mounted
home.

## Flush points (wired in `src/index.ts`)

1. **Periodic:** every `STREAM_SUMMARY_FLUSH_MS = 10_000` ms, serialize the
   manager; skip the write when the JSON is unchanged from the last save (the
   state is a few KB, so stringify-and-compare is negligible).
2. **On summary emit:** inside `onSummary`, **save before `tg.sendText`**. By
   this point `finalizeRoom` has already deleted the session, so the saved
   snapshot no longer contains the room — a crash after the send cannot
   re-emit it on restore (at-most-once). A crash between this save and the
   send loses that summary; accepted.
3. **On shutdown:** add a **SIGTERM** handler (Docker sends SIGTERM; today
   only SIGINT is handled). Both handlers: `await save` → `clearAllTimers` →
   disconnect bridges → disconnect Telegram → exit.

A failed `save()` (disk full, permissions) is logged and never crashes the
process or the flush loop; the previous on-disk snapshot remains intact
thanks to the atomic rename.

## Restore behavior (startup)

Startup order: ensure `bot-data/` → `tg.start()` → `load()` + `restore()` →
connect bridges. Restoring before bridges connect means no events race the
rehydration; restoring after `tg.start()` means a summary emitted later can
actually be delivered.

Per restored room:

- **Was ENDING** (`pendingEndAt` set): re-arm the 45s debounce timer for the
  full `debounceMs`. The summary then emits normally, and a flap-resume
  arriving in time still cancels it — the state machine is unchanged.
- **Was LIVE** (no `pendingEndAt`): restore the session and arm a
  **revalidation timer** of `STREAM_SUMMARY_REVALIDATE_MS = 300_000` (5 min —
  generous headroom over Bilibili's periodic online/watched heartbeats plus
  bridge reconnect time).
  - Any handled event for that room (recordable, `live-start`, or `live-end`)
    cancels the revalidation timer: the stream is genuinely still live, keep
    counting toward one normal summary. A `live-end` simply starts the normal
    ENDING debounce.
  - If it fires with no activity, the stream ended during downtime: finalize
    with `endedAt = lastEventAt`, set `endEstimated = true`, and emit through
    the normal `onSummary` path.

## Message change

`StreamSummary` gains **`endEstimated: boolean`** (default `false`): true when
no `live-end` was observed and `endedAt` is the last event seen (a lower
bound). `formatSummary` renders it as its own warning line in the header
block, independent of the existing `partial` marker, e.g.:

```
⚠️ 未观测到下播（服务中断），结束时间为最后活动时间
```

(wording tweakable at implementation time). A session can carry both markers
(joined mid-stream *and* ended during downtime).

A restored session that continues normally produces a normal, unlabeled
summary — the events lost during downtime are silently accepted per the
stated tolerance.

## Edge cases & limitations

- **Very old snapshot** (bot down for days): the best-effort summary is still
  sent — "never lose a summary" — and its own start/end timestamps make the
  lateness self-explanatory. No age cap, no extra config.
- **Stream A ends during downtime and stream B starts before revalidation
  resolves** (either during the downtime itself or within the 5-min window
  after restart): B's events cancel A's revalidation timer and merge into A's
  restored session, yielding one combined summary. A gap-based tiebreak was
  considered and rejected: downtime itself creates large event gaps, so it
  cannot distinguish "new stream" from "quiet restart" without false splits.
  Accepted as a rare limitation of the cheap approach.
- **Crash between periodic flushes:** loses up to ~10s of stats; accepted.
- **Crash between the pre-send save and the Telegram send:** that summary is
  lost (at-most-once); accepted.
- **Docker:** persistence requires `bot-data/` to be a mounted volume (it
  already must be for the Telegram session to survive container
  replacement). Document in README.

## Files touched

- `src/streamSummary.ts` — `lastEventAt`; `SessionStats.snapshot/restore`;
  `SessionManager.snapshot/restore` + revalidation timers; `endEstimated` in
  `StreamSummary` + `formatSummary` marker; snapshot types.
- **new** `src/summaryPersistence.ts` — `load`/`save` with atomic rename.
- `src/consts.ts` — `STREAM_SUMMARY_FLUSH_MS = 10_000`,
  `STREAM_SUMMARY_REVALIDATE_MS = 300_000`.
- `src/index.ts` — load+restore at startup; periodic flush interval;
  save-before-send in `onSummary`; SIGTERM handler; save on shutdown.
- `README.md` — persistence note + volume-mount caveat.
- `types.ts` / `config.yaml` — **unchanged** (no new configuration).

## Testing

`bun test` against the pure units, same style as the existing suite (real
timers with tiny injected windows, spy `onSummary`):

- **`SessionStats`:** snapshot→restore→finalize deep-equals the original
  finalize (fully populated and empty sessions); `lastEventAt` tracks the max
  event timestamp.
- **`SessionManager`:**
  - snapshot mid-stream → restore into a fresh manager → continue events →
    one summary with combined totals;
  - restore with `pendingEndAt` → summary emits after `debounceMs` (and a
    flap-resume before expiry still cancels it);
  - restore LIVE + event arrives → revalidation canceled, normal summary at
    the real end, `endEstimated === false`;
  - restore LIVE + silence → summary after `revalidateMs` with
    `endEstimated === true` and `endedAt === lastEventAt`.
- **`formatSummary`:** renders the `endEstimated` marker; renders both
  markers when combined with `partial`.
- **`summaryPersistence`:** save/load round-trip; missing file → `null`;
  corrupt JSON / wrong version → `null` with warning; tmp file is not left
  behind after a successful save.

The `onSummary` save-before-send ordering lives in `index.ts` wiring and is
verified by review/manual test rather than unit test.
