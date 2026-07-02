# Stream Summary Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-progress stream-summary state survives process restarts (upgrades, container replacement, crashes) via an atomically-written JSON snapshot, and a stream that ends while the bot is down still gets a best-effort summary.

**Architecture:** `SessionStats`/`SessionManager` (in `src/streamSummary.ts`) gain pure `snapshot()`/`restore()` serialization; a new I/O-only module `src/summaryPersistence.ts` reads/writes the snapshot file atomically; `src/index.ts` wires flush points (10s interval, before each summary send, on SIGINT/SIGTERM) and restores at startup. Restored LIVE rooms get a revalidation timer — silence means the stream ended during downtime, emitting a summary flagged `endEstimated`.

**Tech Stack:** Bun (runtime, `bun test`, `Bun.file`/`Bun.write`), `node:fs/promises` `rename` (atomic replace; no Bun equivalent), Biome formatting.

**Spec:** `docs/superpowers/specs/2026-07-02-stream-summary-persistence-design.md`

## Global Constraints

- Bun toolchain only: `bun test`, `Bun.file`/`Bun.write`; the only `node:` API allowed is `rename`/`unlink` from `node:fs/promises`.
- No new dependencies. `types.ts` and `config.yaml` unchanged — no new configuration.
- Formatting (biome.jsonc): single quotes, semicolons `asNeeded` (write none), 2-space indent, trailing commas `es5`, line width 120, `arrowParentheses: asNeeded`.
- Conventional commits matching repo history (`feat:`, `test:`, `docs:`).
- Snapshot types must be JSON-safe: no `Map`, no `undefined`, no `Date` in serialized form; `Map`s serialize as entry arrays.
- Exact constants: `STREAM_SUMMARY_FLUSH_MS = 10_000`, `STREAM_SUMMARY_REVALIDATE_MS = 300_000`; state file `bot-data/summary-state.json`; temp file is `<path>.tmp`; snapshot `version: 1`.
- Exact marker text: `⚠️ 未观测到下播（服务中断），结束时间为最后活动时间`.
- Every task must leave `bun test` green and `bunx tsc --noEmit` clean.

## File Structure

- `src/streamSummary.ts` (modify) — snapshot types, `lastEventAt`, `endEstimated`, `SessionStats.snapshot/restore`, `SessionManager.snapshot/restore` + revalidation.
- `src/streamSummary.test.ts` (modify) — new tests per task.
- `src/summaryPersistence.ts` (create) — `loadSummarySnapshot`/`saveSummarySnapshot`, atomic rename.
- `src/summaryPersistence.test.ts` (create) — persistence tests.
- `src/consts.ts` (modify) — `STREAM_SUMMARY_REVALIDATE_MS` (Task 4), `STREAM_SUMMARY_FLUSH_MS` (Task 6).
- `src/index.ts` (modify, Task 6 only) — restore at startup, flush interval, save-before-send, SIGTERM.
- `README.md` (modify, Task 6) — persistence + Docker volume note.

---

### Task 1: `SessionStats.lastEventAt`

**Files:**
- Modify: `src/streamSummary.ts` (SessionStats class, ~lines 51–150)
- Test: `src/streamSummary.test.ts`

**Interfaces:**
- Consumes: existing `SessionStats` (constructor `(startedAt: number, partial: boolean)`, `record(event)`).
- Produces: `get lastEventAt(): number` — most recent recorded event's `timestampNormalized`, never below `startedAt`; private backing field is named `lastActivity`. Task 3 serializes it; Task 4 uses it as the best-effort end time.

- [ ] **Step 1: Write the failing test**

Add to `src/streamSummary.test.ts`, after the `'SessionStats with no activity yields empty summary'` test:

```ts
test('SessionStats tracks the latest event timestamp as lastEventAt', () => {
  const stats = new SessionStats(1_000, false)
  expect(stats.lastEventAt).toBe(1_000) // starts at startedAt

  stats.record(ev('message', { uid: 1, username: 'a', timestampNormalized: 5_000 }))
  expect(stats.lastEventAt).toBe(5_000)

  // an out-of-order older event must not move it backwards
  stats.record(ev('online-update', { online: 10, timestampNormalized: 4_000 }))
  expect(stats.lastEventAt).toBe(5_000)

  stats.record(ev('likes-update', { likes: 3, timestampNormalized: 6_500 }))
  expect(stats.lastEventAt).toBe(6_500)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/streamSummary.test.ts -t 'lastEventAt'`
Expected: FAIL (`lastEventAt` is `undefined`, `expect(received).toBe(1000)` fails)

- [ ] **Step 3: Implement**

In `src/streamSummary.ts`, inside `SessionStats`:

Add a field after the `liveStartBound` declaration:

```ts
  /** Timestamp of the most recent recorded event (never below startedAt). */
  private lastActivity: number
```

At the end of the constructor body:

```ts
    this.lastActivity = startedAt
```

Add a getter after the `hasLiveStart` getter:

```ts
  /** Most recent recorded event's timestamp (startedAt when nothing has been recorded yet). */
  get lastEventAt(): number {
    return this.lastActivity
  }
```

Add as the first line of `record(event)`, before the `switch`:

```ts
    if (event.timestampNormalized > this.lastActivity) this.lastActivity = event.timestampNormalized
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/streamSummary.test.ts && bunx tsc --noEmit`
Expected: all tests PASS, tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/streamSummary.ts src/streamSummary.test.ts
git commit -m "feat: track last event timestamp in SessionStats"
```

---

### Task 2: `endEstimated` flag and its summary marker

**Files:**
- Modify: `src/streamSummary.ts` (`StreamSummary` interface ~line 7, `finalize` ~line 152, `formatSummary` header block ~line 226)
- Test: `src/streamSummary.test.ts` (new tests + `baseSummary()` fixture)

**Interfaces:**
- Consumes: `StreamSummary`, `SessionStats.finalize`, `formatSummary`.
- Produces: `StreamSummary.endEstimated: boolean`; `finalize(endedAt: number, endEstimated = false): StreamSummary`. Existing callers stay valid (default `false`). Task 4's `finalizeStale` calls `finalize(session.lastEventAt, true)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/streamSummary.test.ts` after the Task 1 test:

```ts
test('finalize marks endEstimated only when requested', () => {
  const stats = new SessionStats(1_000, false)
  expect(stats.finalize(2_000).endEstimated).toBe(false)
  expect(stats.finalize(2_000, true).endEstimated).toBe(true)
})
```

And after the `'formatSummary marks partial sessions'` test:

```ts
test('formatSummary renders the endEstimated marker', () => {
  const s = baseSummary()
  s.endEstimated = true
  expect(formatSummary(s, room)).toContain('⚠️ 未观测到下播（服务中断），结束时间为最后活动时间')
})

test('formatSummary renders both partial and endEstimated markers together', () => {
  const s = baseSummary()
  s.partial = true
  s.endEstimated = true
  const out = formatSummary(s, room)
  expect(out).toContain('⚠️ 部分数据（监控中途启动）')
  expect(out).toContain('⚠️ 未观测到下播（服务中断），结束时间为最后活动时间')
})
```

Also update the `baseSummary()` fixture: add `endEstimated: false,` on the line after `partial: false,`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/streamSummary.test.ts -t 'endEstimated'`
Expected: FAIL (`endEstimated` is `undefined`; marker not found)

- [ ] **Step 3: Implement**

In `src/streamSummary.ts`:

In the `StreamSummary` interface, after the `partial` member:

```ts
  /** true when no live-end was observed (stream ended while the bot was down); endedAt is the last event seen — a lower bound. */
  endEstimated: boolean
```

Change the `finalize` signature and returned object:

```ts
  finalize(endedAt: number, endEstimated = false): StreamSummary {
```

and in the returned object literal, after `partial: this.partial,`:

```ts
      endEstimated,
```

In `formatSummary`, the header block becomes:

```ts
  let header = `#${room.slug} #直播总结`
  if (s.partial) header = `⚠️ 部分数据（监控中途启动）\n${header}`
  if (s.endEstimated) header = `⚠️ 未观测到下播（服务中断），结束时间为最后活动时间\n${header}`
  blocks.push(header)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/streamSummary.test.ts && bunx tsc --noEmit`
Expected: all tests PASS, tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/streamSummary.ts src/streamSummary.test.ts
git commit -m "feat: add endEstimated flag for streams that end during downtime"
```

---

### Task 3: `SessionStats.snapshot()` / `SessionStats.restore()`

**Files:**
- Modify: `src/streamSummary.ts`
- Test: `src/streamSummary.test.ts`

**Interfaces:**
- Consumes: `SessionStats` fields (all private counters, `lastActivity` from Task 1).
- Produces (used by Task 4 and Task 5):

```ts
/** JSON-safe serialized form of SessionStats (Maps as entry arrays). */
export interface SessionStatsSnapshot {
  startedAt: number
  partial: boolean
  liveStartBound: boolean
  lastEventAt: number
  chats: number
  chatters: Array<[number, { name: string; count: number }]>
  watchedMax: number
  onlinePeak: number
  onlineSum: number
  onlineSamples: number
  likesMax: number
  newFollows: number
  giftCount: number
  giftRevenue: number
  scCount: number
  scRevenue: number
  guardCount: number
  guardRevenue: number
  spenders: Array<[number, { name: string; total: number }]>
}
```

plus `snapshot(): SessionStatsSnapshot` and `static restore(snap: SessionStatsSnapshot): SessionStats`.

- [ ] **Step 1: Write the failing tests**

Add to `src/streamSummary.test.ts` (extend the type-only import at the bottom section or add near the other `./streamSummary` imports):

```ts
import type { SessionStatsSnapshot } from './streamSummary'
```

```ts
test('SessionStats snapshot/restore round-trips through JSON', () => {
  const stats = new SessionStats(1_000, false)
  stats.record(ev('message', { uid: 1, username: 'a', timestampNormalized: 1_100 }))
  stats.record(ev('message', { uid: 1, username: 'a', timestampNormalized: 1_200 }))
  stats.record(ev('message', { uid: 2, username: 'b', timestampNormalized: 1_300 }))
  stats.record(ev('watched-update', { watched: 250 }))
  stats.record(ev('online-update', { online: 50 }))
  stats.record(ev('online-update', { online: 80 }))
  stats.record(ev('likes-update', { likes: 3_000 }))
  stats.record(ev('interaction', { action: 2 }))
  stats.record(ev('gift', { uid: 2, username: 'b', coinType: 'gold', priceNormalized: 30 }))
  stats.record(ev('superchat', { uid: 3, username: 'c', priceNormalized: 50, message: 'hi' }))
  stats.record(ev('toast', { uid: 3, username: 'c', priceNormalized: 198 }))

  // Round-trip through actual JSON to prove the snapshot is JSON-safe
  const snap = JSON.parse(JSON.stringify(stats.snapshot())) as SessionStatsSnapshot
  const restored = SessionStats.restore(snap)

  expect(restored.lastEventAt).toBe(stats.lastEventAt)
  expect(restored.hasLiveStart).toBe(true)
  expect(restored.finalize(9_000)).toEqual(stats.finalize(9_000))
})

test('SessionStats restore preserves partial/anchor state and keeps accumulating', () => {
  const stats = new SessionStats(5_000, true) // partial, not yet anchored
  stats.record(ev('message', { uid: 1, username: 'a', timestampNormalized: 5_100 }))

  const restored = SessionStats.restore(stats.snapshot())
  expect(restored.partial).toBe(true)
  expect(restored.hasLiveStart).toBe(false)

  restored.record(ev('message', { uid: 2, username: 'b', timestampNormalized: 5_200 }))
  const s = restored.finalize(6_000)
  expect(s.chats).toBe(2)
  expect(s.uniqueChatters).toBe(2)
  expect(s.partial).toBe(true)
})

test('SessionStats restore preserves a promoted (anchored) partial session', () => {
  const stats = new SessionStats(5_000, true)
  stats.bindLiveStart() // promoted by a real live-start
  const restored = SessionStats.restore(stats.snapshot())
  expect(restored.partial).toBe(true)
  expect(restored.hasLiveStart).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/streamSummary.test.ts -t 'snapshot'`
Expected: FAIL (`stats.snapshot is not a function`)

- [ ] **Step 3: Implement**

In `src/streamSummary.ts`, add the `SessionStatsSnapshot` interface (from the Interfaces block above, verbatim) directly above the `SessionStats` class.

Add the two methods at the end of the `SessionStats` class body (after `finalize`):

```ts
  /** Serialize every accumulator field into a JSON-safe object. */
  snapshot(): SessionStatsSnapshot {
    const chatters: Array<[number, { name: string; count: number }]> = []
    for (const [uid, v] of this.chatters) chatters.push([uid, { ...v }])
    const spenders: Array<[number, { name: string; total: number }]> = []
    for (const [uid, v] of this.spenders) spenders.push([uid, { ...v }])
    return {
      startedAt: this.startedAt,
      partial: this.partial,
      liveStartBound: this.liveStartBound,
      lastEventAt: this.lastActivity,
      chats: this.chats,
      chatters,
      watchedMax: this.watchedMax,
      onlinePeak: this.onlinePeak,
      onlineSum: this.onlineSum,
      onlineSamples: this.onlineSamples,
      likesMax: this.likesMax,
      newFollows: this.newFollows,
      giftCount: this.giftCount,
      giftRevenue: this.giftRevenue,
      scCount: this.scCount,
      scRevenue: this.scRevenue,
      guardCount: this.guardCount,
      guardRevenue: this.guardRevenue,
      spenders,
    }
  }

  /** Exact inverse of snapshot(): restore(x.snapshot()).finalize(t) deep-equals x.finalize(t). */
  static restore(snap: SessionStatsSnapshot): SessionStats {
    const s = new SessionStats(snap.startedAt, snap.partial)
    s.liveStartBound = snap.liveStartBound
    s.lastActivity = snap.lastEventAt
    s.chats = snap.chats
    for (const [uid, v] of snap.chatters) s.chatters.set(uid, { ...v })
    s.watchedMax = snap.watchedMax
    s.onlinePeak = snap.onlinePeak
    s.onlineSum = snap.onlineSum
    s.onlineSamples = snap.onlineSamples
    s.likesMax = snap.likesMax
    s.newFollows = snap.newFollows
    s.giftCount = snap.giftCount
    s.giftRevenue = snap.giftRevenue
    s.scCount = snap.scCount
    s.scRevenue = snap.scRevenue
    s.guardCount = snap.guardCount
    s.guardRevenue = snap.guardRevenue
    for (const [uid, v] of snap.spenders) s.spenders.set(uid, { ...v })
    return s
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/streamSummary.test.ts && bunx tsc --noEmit`
Expected: all tests PASS, tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/streamSummary.ts src/streamSummary.test.ts
git commit -m "feat: add SessionStats snapshot/restore serialization"
```

---

### Task 4: `SessionManager` snapshot/restore + post-restore revalidation

**Files:**
- Modify: `src/consts.ts` (after `STREAM_SUMMARY_DEBOUNCE_MS`)
- Modify: `src/streamSummary.ts` (`SessionManagerOptions`, `SessionManager`)
- Test: `src/streamSummary.test.ts` (update `makeManager`, add tests)

**Interfaces:**
- Consumes: `SessionStatsSnapshot`, `SessionStats.restore`, `SessionStats.snapshot`, `session.lastEventAt` (Task 1/3), `finalize(endedAt, endEstimated)` (Task 2).
- Produces (used by Tasks 5–6):

```ts
/** One room's persisted state: its session plus the pending end (ENDING state) if any. */
export interface RoomSnapshot {
  pendingEndAt: number | null
  session: SessionStatsSnapshot
}

/** JSON-safe serialized form of SessionManager (timers are re-derived on restore). */
export interface ManagerSnapshot {
  version: 1
  savedAt: number
  rooms: Array<[number, RoomSnapshot]>
}
```

- `SessionManagerOptions` gains `revalidateMs?: number` (defaults to `STREAM_SUMMARY_REVALIDATE_MS`).
- `SessionManager.snapshot(): ManagerSnapshot`, `SessionManager.restore(snap: ManagerSnapshot): void`.
- `src/consts.ts` gains `STREAM_SUMMARY_REVALIDATE_MS = 300_000`.

- [ ] **Step 1: Add the constant**

In `src/consts.ts`, after `STREAM_SUMMARY_DEBOUNCE_MS`:

```ts
/**
 * After restoring a LIVE room from a persisted snapshot, how long to wait for
 * any event before declaring the stream ended during downtime and emitting a
 * best-effort summary. Generous headroom over Bilibili's periodic
 * online/watched heartbeats plus bridge reconnect time.
 */
export const STREAM_SUMMARY_REVALIDATE_MS = 300_000
```

- [ ] **Step 2: Update `makeManager` and write the failing tests**

In `src/streamSummary.test.ts`, extend the type import added in Task 3:

```ts
import type { ManagerSnapshot, SessionStatsSnapshot } from './streamSummary'
```

Replace the existing `makeManager` with (adds a required-for-tests small revalidation window):

```ts
function makeManager() {
  const calls: Array<{ roomId: number; summary: StreamSummary }> = []
  const manager = new SessionManager({
    debounceMs: 30,
    revalidateMs: 30,
    onSummary: (roomId, summary) => {
      calls.push({ roomId, summary })
    },
  })
  return { calls, manager }
}
```

Add these tests at the end of the file:

```ts
test('SessionManager: snapshot captures LIVE and ENDING rooms', () => {
  const { manager } = makeManager()
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 1_100 }))
  manager.handle(200, ev('live-start', { timestampNormalized: 2_000 }))
  manager.handle(200, ev('live-end', { timestampNormalized: 3_000 }))

  const snap = manager.snapshot()
  manager.clearAllTimers()

  expect(snap.version).toBe(1)
  expect(typeof snap.savedAt).toBe('number')
  expect(snap.rooms.length).toBe(2)
  const room100 = snap.rooms.find(([id]) => id === 100)?.[1]
  const room200 = snap.rooms.find(([id]) => id === 200)?.[1]
  expect(room100?.pendingEndAt).toBeNull()
  expect(room100?.session.chats).toBe(1)
  expect(room100?.session.lastEventAt).toBe(1_100)
  expect(room200?.pendingEndAt).toBe(3_000)
})

test('SessionManager: a restored ENDING room emits after the debounce', async () => {
  const a = makeManager()
  a.manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  a.manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 1_100 }))
  a.manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  const snap = JSON.parse(JSON.stringify(a.manager.snapshot())) as ManagerSnapshot
  a.manager.clearAllTimers() // simulate shutdown before the debounce fired

  const b = makeManager()
  b.manager.restore(snap)
  await Bun.sleep(60)

  expect(b.calls.length).toBe(1)
  expect(b.calls[0]?.summary.endedAt).toBe(2_000) // the observed live-end, not wall clock
  expect(b.calls[0]?.summary.endEstimated).toBe(false)
  expect(b.calls[0]?.summary.chats).toBe(1)
})

test('SessionManager: a restored ENDING room can still flap-resume', async () => {
  const a = makeManager()
  a.manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  a.manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  const snap = a.manager.snapshot()
  a.manager.clearAllTimers()

  const b = makeManager()
  b.manager.restore(snap)
  b.manager.handle(100, ev('live-start', { timestampNormalized: 2_010 })) // resume cancels the re-armed debounce
  await Bun.sleep(60)
  expect(b.calls.length).toBe(0)

  b.manager.handle(100, ev('live-end', { timestampNormalized: 3_000 }))
  await Bun.sleep(60)
  expect(b.calls.length).toBe(1)
  expect(b.calls[0]?.summary.startedAt).toBe(1_000)
  expect(b.calls[0]?.summary.endedAt).toBe(3_000)
})

test('SessionManager: a restored LIVE room with no activity emits a best-effort summary', async () => {
  const a = makeManager()
  a.manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  a.manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 1_500 }))
  const snap = a.manager.snapshot()
  a.manager.clearAllTimers()

  const b = makeManager()
  b.manager.restore(snap)
  await Bun.sleep(60) // past revalidateMs with no events

  expect(b.calls.length).toBe(1)
  expect(b.calls[0]?.summary.endEstimated).toBe(true)
  expect(b.calls[0]?.summary.endedAt).toBe(1_500) // lastEventAt, not wall clock
  expect(b.calls[0]?.summary.chats).toBe(1)
})

test('SessionManager: any event cancels revalidation and the stream continues', async () => {
  const a = makeManager()
  a.manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  a.manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 1_500 }))
  const snap = a.manager.snapshot()
  a.manager.clearAllTimers()

  const b = makeManager()
  b.manager.restore(snap)
  b.manager.handle(100, ev('message', { uid: 2, username: 'b', timestampNormalized: 5_000 }))
  await Bun.sleep(60) // past revalidateMs — must NOT fire, the room proved it is live
  expect(b.calls.length).toBe(0)

  b.manager.handle(100, ev('live-end', { timestampNormalized: 6_000 }))
  await Bun.sleep(60)
  expect(b.calls.length).toBe(1)
  expect(b.calls[0]?.summary.endEstimated).toBe(false)
  expect(b.calls[0]?.summary.chats).toBe(2) // pre-restart + post-restart merged
  expect(b.calls[0]?.summary.startedAt).toBe(1_000)
})

test('SessionManager: clearAllTimers cancels revalidation timers too', async () => {
  const a = makeManager()
  a.manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  const snap = a.manager.snapshot()
  a.manager.clearAllTimers()

  const b = makeManager()
  b.manager.restore(snap)
  b.manager.clearAllTimers()
  await Bun.sleep(60)
  expect(b.calls.length).toBe(0)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/streamSummary.test.ts`
Expected: FAIL — TypeScript/`ManagerSnapshot` unresolved and `manager.snapshot is not a function`; pre-existing tests still pass

- [ ] **Step 4: Implement**

In `src/streamSummary.ts`:

Add to the imports:

```ts
import { STREAM_SUMMARY_REVALIDATE_MS } from './consts'
```

Add the two interfaces (verbatim from the Interfaces block above) right after the `SessionStatsSnapshot` interface: `RoomSnapshot`, `ManagerSnapshot`.

In `SessionManagerOptions`, after `debounceMs: number`:

```ts
  /**
   * Silence window after restoring a LIVE room before declaring the stream
   * ended during downtime (defaults to STREAM_SUMMARY_REVALIDATE_MS).
   */
  revalidateMs?: number
```

In `SessionManager`, add fields after `pendingEndAt`:

```ts
  private readonly revalidateMs: number
  private readonly revalidateTimers = new Map<number, ReturnType<typeof setTimeout>>()
```

In the constructor, after `this.debounceMs = opts.debounceMs`:

```ts
    this.revalidateMs = opts.revalidateMs ?? STREAM_SUMMARY_REVALIDATE_MS
```

Add a private helper after the constructor:

```ts
  /** Cancel a pending post-restore revalidation: the room has shown signs of life. */
  private cancelRevalidation(roomId: number): void {
    const timer = this.revalidateTimers.get(roomId)
    if (timer) {
      clearTimeout(timer)
      this.revalidateTimers.delete(roomId)
    }
  }
```

In `handle()`, add `this.cancelRevalidation(roomId)` as the **first statement** of the `'live-start'` case and of the `'live-end'` case, and in the `default` case **after** the `RECORDABLE_TYPES` guard:

```ts
      default: {
        if (!RECORDABLE_TYPES.has(event.type)) return
        this.cancelRevalidation(roomId)
        let session = this.sessions.get(roomId)
        // ... rest unchanged
```

Replace `clearAllTimers` with:

```ts
  /** Cancel all pending timers (e.g. on shutdown). */
  clearAllTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const timer of this.revalidateTimers.values()) clearTimeout(timer)
    this.revalidateTimers.clear()
  }
```

Add `snapshot`, `restore`, and `finalizeStale` after `clearAllTimers`:

```ts
  /** Serialize all rooms' in-progress state (JSON-safe; timers are re-derived on restore). */
  snapshot(): ManagerSnapshot {
    const rooms: Array<[number, RoomSnapshot]> = []
    for (const [roomId, session] of this.sessions) {
      rooms.push([
        roomId,
        { pendingEndAt: this.pendingEndAt.get(roomId) ?? null, session: session.snapshot() },
      ])
    }
    return { version: 1, savedAt: Date.now(), rooms }
  }

  /**
   * Rehydrate sessions from a snapshot (startup only). ENDING rooms re-arm the
   * debounce for the full window; LIVE rooms get one revalidation window to
   * prove the stream is still running, else a best-effort summary is emitted.
   */
  restore(snap: ManagerSnapshot): void {
    for (const [roomId, room] of snap.rooms) {
      this.sessions.set(roomId, SessionStats.restore(room.session))
      if (room.pendingEndAt !== null) {
        this.pendingEndAt.set(roomId, room.pendingEndAt)
        this.timers.set(
          roomId,
          setTimeout(() => this.finalizeRoom(roomId), this.debounceMs)
        )
      } else {
        this.revalidateTimers.set(
          roomId,
          setTimeout(() => this.finalizeStale(roomId), this.revalidateMs)
        )
      }
    }
  }

  /**
   * Post-restore revalidation expired with no activity: the stream ended while
   * the bot was down. Emit a best-effort summary bounded by the last event seen.
   */
  private finalizeStale(roomId: number): void {
    this.revalidateTimers.delete(roomId)
    const session = this.sessions.get(roomId)
    this.sessions.delete(roomId)
    if (!session) return

    const summary = session.finalize(session.lastEventAt, true)
    Promise.resolve(this.onSummary(roomId, summary)).catch(err =>
      console.error(`[summary] onSummary failed for room ${roomId}:`, err)
    )
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all tests PASS (including all pre-existing ones), tsc clean

- [ ] **Step 6: Commit**

```bash
git add src/consts.ts src/streamSummary.ts src/streamSummary.test.ts
git commit -m "feat: add SessionManager snapshot/restore with post-restore revalidation"
```

---

### Task 5: `summaryPersistence` module (atomic file I/O)

**Files:**
- Create: `src/summaryPersistence.ts`
- Create: `src/summaryPersistence.test.ts`

**Interfaces:**
- Consumes: `ManagerSnapshot` (Task 4).
- Produces (used by Task 6):
  - `loadSummarySnapshot(path: string): Promise<ManagerSnapshot | null>` — `null` on missing file (silent), corrupt JSON, or version ≠ 1 (warn); never throws.
  - `saveSummarySnapshot(path: string, snap: ManagerSnapshot): Promise<void>` — writes `<path>.tmp` then atomically renames over `<path>`; throws on I/O failure (callers handle).

- [ ] **Step 1: Write the failing tests**

Create `src/summaryPersistence.test.ts`:

```ts
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import type { ManagerSnapshot } from './streamSummary'

import { loadSummarySnapshot, saveSummarySnapshot } from './summaryPersistence'

const path = join(tmpdir(), `laplace-jupiter-summary-state-${process.pid}.json`)

afterEach(async () => {
  await unlink(path).catch(() => {})
  await unlink(`${path}.tmp`).catch(() => {})
})

function fixture(): ManagerSnapshot {
  return {
    version: 1,
    savedAt: 1_751_400_000_000,
    rooms: [
      [
        100,
        {
          pendingEndAt: null,
          session: {
            startedAt: 1_000,
            partial: false,
            liveStartBound: true,
            lastEventAt: 1_500,
            chats: 1,
            chatters: [[1, { name: 'a', count: 1 }]],
            watchedMax: 250,
            onlinePeak: 80,
            onlineSum: 130,
            onlineSamples: 2,
            likesMax: 3_000,
            newFollows: 2,
            giftCount: 2,
            giftRevenue: 40,
            scCount: 2,
            scRevenue: 150,
            guardCount: 2,
            guardRevenue: 396,
            spenders: [[3, { name: 'c', total: 248 }]],
          },
        },
      ],
    ],
  }
}

test('save/load round-trips a snapshot', async () => {
  await saveSummarySnapshot(path, fixture())
  expect(await loadSummarySnapshot(path)).toEqual(fixture())
})

test('load returns null for a missing file', async () => {
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('load returns null for corrupt JSON', async () => {
  await Bun.write(path, '{not json')
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('load returns null for an unsupported version', async () => {
  await Bun.write(path, JSON.stringify({ version: 99, savedAt: 0, rooms: [] }))
  expect(await loadSummarySnapshot(path)).toBeNull()
})

test('save leaves no tmp file behind', async () => {
  await saveSummarySnapshot(path, fixture())
  expect(await Bun.file(`${path}.tmp`).exists()).toBe(false)
})

test('save overwrites a previous snapshot atomically', async () => {
  await saveSummarySnapshot(path, fixture())
  const next = fixture()
  next.savedAt = 1_751_400_010_000
  next.rooms = []
  await saveSummarySnapshot(path, next)
  expect(await loadSummarySnapshot(path)).toEqual(next)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/summaryPersistence.test.ts`
Expected: FAIL (`Cannot find module './summaryPersistence'`)

- [ ] **Step 3: Implement**

Create `src/summaryPersistence.ts`:

```ts
import { rename } from 'node:fs/promises'

import type { ManagerSnapshot } from './streamSummary'

/**
 * Read a previously saved summary snapshot. Returns null (never throws) when
 * the file is missing, unparseable, or has an unsupported version — the bot
 * then simply starts with empty state.
 */
export async function loadSummarySnapshot(path: string): Promise<ManagerSnapshot | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    const data = (await file.json()) as ManagerSnapshot
    if (data?.version !== 1 || !Array.isArray(data.rooms)) {
      console.warn(`[summary] Discarding snapshot with unsupported shape/version: ${path}`)
      return null
    }
    return data
  } catch (err) {
    console.warn(`[summary] Discarding unreadable snapshot ${path}:`, err)
    return null
  }
}

/**
 * Atomically persist a snapshot: write <path>.tmp, then rename over <path>.
 * A crash mid-write leaves the previous snapshot intact (POSIX rename).
 * Throws on I/O failure — callers log and carry on.
 */
export async function saveSummarySnapshot(path: string, snap: ManagerSnapshot): Promise<void> {
  const tmp = `${path}.tmp`
  await Bun.write(tmp, JSON.stringify(snap))
  await rename(tmp, path)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all tests PASS, tsc clean

- [ ] **Step 5: Commit**

```bash
git add src/summaryPersistence.ts src/summaryPersistence.test.ts
git commit -m "feat: add atomic summary state persistence"
```

---

### Task 6: Wire persistence into the app + README

**Files:**
- Modify: `src/consts.ts`
- Modify: `src/index.ts`
- Modify: `README.md:62-66` (the "in memory" paragraph) and `README.md:71` (after the multi-bridge note)

**Interfaces:**
- Consumes: `loadSummarySnapshot`/`saveSummarySnapshot` (Task 5), `summaryManager.snapshot()`/`.restore()` (Task 4).
- Produces: running app behavior; no new exports.

There are no unit tests for this task (it is I/O wiring); verification is typecheck + full suite + lint + a startup smoke check.

- [ ] **Step 1: Add the flush constant**

In `src/consts.ts`, after `STREAM_SUMMARY_REVALIDATE_MS`:

```ts
/** Persist stream-summary state at most this often (the write is skipped when nothing changed). */
export const STREAM_SUMMARY_FLUSH_MS = 10_000
```

- [ ] **Step 2: Wire `src/index.ts`**

2a. Extend the consts import and add the persistence import (final import block):

```ts
import {
  EMOJI_MAP,
  GUARD_TYPE_DICT,
  PRICE_TIER_EMOJI,
  STREAM_SUMMARY_DEBOUNCE_MS,
  STREAM_SUMMARY_FLUSH_MS,
  SUPERCHAT_TIER_EMOJI,
} from './consts'
import { EventStore, formatMessagesContext } from './eventStore'
import { formatSummary, SessionManager } from './streamSummary'
import { loadSummarySnapshot, saveSummarySnapshot } from './summaryPersistence'
import { timeFromNow } from './utils'
```

2b. After the `const botDataDir = 'bot-data'` line:

```ts
const summaryStatePath = `${botDataDir}/summary-state.json`
```

2c. Replace the `summaryManager` construction so the state is persisted **before** the send (at-most-once delivery):

```ts
// Stream summary: accumulate per-room metrics and emit a summary after each stream
const summaryManager = new SessionManager({
  debounceMs: STREAM_SUMMARY_DEBOUNCE_MS,
  onSummary: async (roomId, summary) => {
    const room = roomMap.get(roomId)
    if (!room) return
    // Persist first: the finalized room is already gone from the snapshot, so
    // a crash after the send cannot re-emit this summary on the next restore.
    await flushSummaryState()
    const message = formatSummary(summary, room, md.escape)
    try {
      await tg.sendText(room.telegram_announce_ch, md(message), { disableWebPreview: true })
      console.log(`[summary] Sent stream summary for ${room.slug} (${roomId})`)
    } catch (err) {
      console.error(`[summary] Failed to send summary for ${room.slug} (${roomId}):`, err)
    }
  },
})

// Persist manager state so in-progress streams survive restarts. Compares the
// rooms payload (savedAt alone must not count as a change) and skips unchanged
// writes. Save failures are logged and never crash the flush loop — the
// previous on-disk snapshot stays intact thanks to the atomic rename.
let lastPersistedRooms: string | null = null
async function flushSummaryState(): Promise<void> {
  const snap = summaryManager.snapshot()
  const roomsJson = JSON.stringify(snap.rooms)
  if (roomsJson === lastPersistedRooms) return
  try {
    await saveSummarySnapshot(summaryStatePath, snap)
    lastPersistedRooms = roomsJson
  } catch (err) {
    console.error('[summary] Failed to persist summary state:', err)
  }
}
```

Note: `revalidateMs` is deliberately not passed — the manager defaults to `STREAM_SUMMARY_REVALIDATE_MS`.

2d. In `start()`, right after the `console.log('Logged in as', user.username)` line (restore before bridges connect so no events race the rehydration):

```ts
    // Restore in-progress stream sessions persisted by a previous run
    const restored = await loadSummarySnapshot(summaryStatePath)
    if (restored) {
      summaryManager.restore(restored)
      console.log(`[summary] Restored ${restored.rooms.length} in-progress session(s)`)
    }
    setInterval(() => {
      void flushSummaryState()
    }, STREAM_SUMMARY_FLUSH_MS)
```

2e. Replace the whole `process.on('SIGINT', ...)` block (including its `// Graceful shutdown` comment) with:

```ts
// Graceful shutdown (SIGINT from a terminal, SIGTERM from Docker)
async function shutdown() {
  console.log('\nShutting down...')

  // Persist in-progress sessions, then cancel pending timers — restore()
  // re-arms them on the next startup
  await flushSummaryState()
  summaryManager.clearAllTimers()

  // Disconnect all event bridges
  for (const { name, client } of clients) {
    console.log(`Disconnecting from ${name}...`)
    client.disconnect()
  }

  await tg.disconnect()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

- [ ] **Step 3: Update `README.md`**

Replace the paragraph at lines 62–66 ("Metrics are accumulated **in memory** — … truly ended.") with:

```markdown
Metrics are accumulated in memory and snapshotted to `bot-data/summary-state.json`
(atomic temp-file + rename; every 10s while state changes, before each summary is
sent, and on shutdown), so in-progress streams survive restarts, upgrades, and
crashes. A hard crash loses at most ~10s of stats; events that arrive while the
bot is down are not counted. If a stream ends entirely during downtime, a
best-effort summary (marked ⚠️) is still sent after startup once the room stays
silent for the revalidation window (`STREAM_SUMMARY_REVALIDATE_MS`, default
5 min). Bilibili fires `live-start`/`live-end` repeatedly and flaps on brief
drops, so the summary is sent after a debounce window
(`STREAM_SUMMARY_DEBOUNCE_MS`, default 45s) once the stream has truly ended.
```

Then, directly after the existing multi-bridge blockquote (line 71), add:

```markdown
> **Docker note:** mount `bot-data/` as a volume (it already holds the Telegram
> session) or summary state will not survive container replacement.
```

- [ ] **Step 4: Verify**

Run: `bunx tsc --noEmit && bun test && bun run lint`
Expected: tsc clean (this typechecks all of the `index.ts` wiring); all tests PASS; biome reports no errors (if it flags formatting, run `bun run format` and re-check)

- [ ] **Step 5: Commit**

```bash
git add src/consts.ts src/index.ts README.md
git commit -m "feat: persist stream summary state across restarts"
```

---

## Verification checklist (end of plan)

- `bun test` — full suite green (existing + ~15 new tests).
- `bunx tsc --noEmit` — clean.
- `bun run lint` — clean.
- Manual (optional, needs real tokens): start the bot, let a room accumulate a few events, `kill -TERM` the process, confirm `bot-data/summary-state.json` exists, restart, and look for `[summary] Restored N in-progress session(s)` in the log.
