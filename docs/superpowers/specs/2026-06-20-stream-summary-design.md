# Stream Summary Notification — Design

**Date:** 2026-06-20
**Status:** Approved
**Component:** `laplace-jupiter`

## Goal

After a streamer's Bilibili live ends, post a single end-of-stream **summary
notification** to that room's Telegram channel, reporting metrics accumulated
over the whole stream: chat, audience, monetary income, and per-user
highlights.

## Key decisions

- **No database, no persistence.** Metrics are counts/sums/maxes, so they are
  accumulated in RAM per room (a sibling of the existing in-memory
  `EventStore`). A process restart loses the in-progress stream's totals — this
  is an accepted trade-off in exchange for simplicity.
- **No new configuration.** The feature is always on for every room already in
  `config.yaml`. No per-room opt-in flag. `types.ts` and `config.yaml` are
  unchanged.
- **Debounced end.** Bilibili fires `live-start`/`live-end` repeatedly (often
  several times within ~3 seconds) and also flaps end→start on brief encoder /
  network blips. A 45-second debounce plus an explicit state machine collapses
  these bursts into one logical stream and one summary.

## Metrics captured

Always: **stream duration** + start/end timestamps.

- **Monetary** — gift count + revenue (gold/paid gifts only), super chat count
  + revenue, 大航海/guard count + revenue, and grand total revenue
  (gift + sc + guard).
- **Audience** — 看过 (`watched-update.watched`, peak), peak online
  (`online-update.online`), total likes (`likes-update.likes`, peak), new
  follows (`interaction.action === 2 || === 4`).
- **Chat activity** — total danmaku count, unique chatter count.
- **Highlights (per-user)** — top gifter, biggest single super chat, most
  active chatter.

## Architecture

One new file, **`src/streamSummary.ts`**, following the existing
`eventStore.ts` convention (class + helper in one file). It exports three
isolated units:

| Unit | Responsibility | I/O |
|------|----------------|-----|
| `SessionStats` | Pure accumulator for one stream. `record(event)` mutates counters; `finalize(endedAt)` returns a plain `StreamSummary`. | none — pure, unit-testable |
| `SessionManager` | Owns `Map<roomId, SessionStats>` and `Map<roomId, Timer>`. Drives the lifecycle state machine. Calls an injected `onSummary(roomId, summary)` callback. | timers only |
| `formatSummary(summary, roomCfg)` | Pure function → Telegram markdown string. | none — pure, testable |

`src/index.ts` instantiates one `SessionManager` whose `onSummary` callback
reuses the existing `sender()` to post to the room's `telegram_announce_ch`
(same channel as the current 开播/下播 messages). Telegram concerns stay out of
the stats logic so it can be tested without a bot or WebSocket.

A small `formatDuration(ms)` helper is added to `src/utils.ts`. A
`STREAM_SUMMARY_DEBOUNCE_MS = 45_000` const is added to `src/consts.ts`.

### `SessionStats` data model

```
startedAt / endedAt / partial            // partial=true if no live-start was seen (bot started mid-stream)
chats                                     // count of `message` events
chatters: Map<uid, {name, count}>        // .size = unique chatters; max by count = most active chatter
watchedMax / onlinePeak / likesMax       // running max of watched-update / online-update / likes-update
newFollows                               // count of interaction.action === 2 || === 4
gifts:  {count, revenue}                 // `gift` where coinType === 'gold' (paid only)
sc:     {count, revenue}                 // `superchat`
guards: {count, revenue}                 // `toast`
gifters: Map<uid, {name, total}>         // max by total = top gifter
biggestSc: {uid, name, amount, message}  // running max single super chat
```

Grand total revenue = `gifts.revenue + sc.revenue + guards.revenue`. The two
`Map`s are the only non-trivial memory and are acceptable in RAM (the existing
`EventStore` already holds up to 6000 full message objects per room).

**`record(event)`** switches on `event.type`:
- `message` → `chats++`; upsert `chatters[uid]`.
- `watched-update` → `watchedMax = max(watchedMax, watched)`.
- `online-update` → `onlinePeak = max(onlinePeak, online)`.
- `likes-update` → `likesMax = max(likesMax, likes)`.
- `interaction` with `action === 2 || action === 4` → `newFollows++`.
- `gift` with `coinType === 'gold'` → `gifts.count++`, `gifts.revenue += priceNormalized`; upsert `gifters[uid]`.
- `superchat` → `sc.count++`, `sc.revenue += priceNormalized`; update `biggestSc` if larger.
- `toast` → `guards.count++`, `guards.revenue += priceNormalized`.

All other event types are ignored by the accumulator.

## Lifecycle state machine

Per room, state is one of `IDLE`, `LIVE`, `ENDING`. This is what makes the
feature robust to Bilibili's repeated/duplicate lifecycle events.

| State | Event | Action | Next state |
|-------|-------|--------|------------|
| `IDLE` | `live-start` | create `SessionStats` | `LIVE` |
| `IDLE` | mid-stream event (no start seen) | lazily create `SessionStats` with `partial=true` | `LIVE` |
| `IDLE` | `live-end` | ignore (no session) | `IDLE` |
| `LIVE` | `live-start` (duplicate burst) | **ignore** — do not reset stats | `LIVE` |
| `LIVE` | recordable event | `stats.record(event)` | `LIVE` |
| `LIVE` | `live-end` | set `pendingEndAt = event.timestampNormalized`; start 45s timer | `ENDING` |
| `ENDING` | `live-end` (duplicate burst) | update `pendingEndAt`; **restart** 45s timer | `ENDING` |
| `ENDING` | `live-start` (resume within window) | **cancel timer**; keep stats (continuation) | `LIVE` |
| `ENDING` | recordable event | `stats.record(event)` (still counts) | `ENDING` |
| `ENDING` | timer fires | `finalize(pendingEndAt)` → `onSummary` → delete session | `IDLE` |

Consequences:
- Multiple `live-start` within ~3s → first enters `LIVE`, the rest are ignored.
- Multiple `live-end` within ~3s → timer keeps resetting; exactly one summary
  fires ~45s after the last `live-end`.
- A brief end→start flap (encoder restart) → the `live-start` cancels the timer;
  one continuous stream, one summary.
- **End time is the `live-end` timestamp**, not the (45s-later) moment the timer
  fires.

## Summary message (illustrative wording, tweakable)

Markdown, project hashtag+emoji style, posted to `telegram_announce_ch`. Empty
sections (e.g. no super chats) are omitted.

```
#直播总结 📊 明前奶绿

🕐 时长 3小时42分  ·  19:00 → 22:42

💰 总收入 ¥2,817.5
   🎁 礼物 87 ¥1,240.5
   💌 醒目留言 12 ¥980
   ⚓ 大航海 3 ¥597

👥 看过 18,650  ·  🟢 峰值在线 3,420
👍 点赞 95,000  ·  ➕ 新增关注 233
💬 弹幕 4,213  ·  🗣️ 发言 892 人

🏆 最佳金主 @xxx ¥680
🔥 最高 SC @yyy ¥500
⚡ 最活跃 @zzz 142 条
```

A `partial` summary is prefixed with a marker (e.g. `⚠️ 部分数据（监控中途启动）`)
and omits/adjusts duration since the true start is unknown.

## Edge cases & limitations

- **Bot starts mid-stream** (no `live-start` seen): events lazily create a
  `partial` session; the summary is still sent, clearly labeled, using the first
  recorded event's time as a lower-bound start.
- **Multi-bridge duplicates**: counts assume the room is pinned to a single
  `bridge` (the same constraint the current setup already relies on to avoid
  duplicate notifications). Noted in README.
- **Deleted super chats**: counted at receive time; later deletions
  (`superchat-delete`) are not subtracted. Rare; accepted.
- **Graceful shutdown** (SIGINT): clear all pending debounce timers; no summary
  is emitted on a deliberate shutdown (in-memory data is discarded, as accepted).

## Files touched

- **new** `src/streamSummary.ts` — `SessionStats`, `SessionManager`, `formatSummary`, types.
- `src/consts.ts` — add `STREAM_SUMMARY_DEBOUNCE_MS` (+ any summary emoji).
- `src/utils.ts` — add `formatDuration(ms)`.
- `src/index.ts` — instantiate `SessionManager`; route events to
  `record`/`onLiveStart`/`onLiveEnd`; clear timers on SIGINT.
- `README.md` — document the feature + multi-bridge caveat.
- `types.ts` / `config.yaml` — **unchanged**.

## Testing

`bun test` against the pure units (no network):
- `SessionStats`: feed a synthetic event sequence, assert `finalize()` totals,
  unique-chatter count, top gifter, biggest SC, peak/max values.
- `formatSummary`: assert rendered output and section omission.
- `SessionManager`: drive the state machine with injected timer control + a spy
  `onSummary` to verify burst dedup, continuation, and single-emit behavior.

No Telegram or WebSocket required.
