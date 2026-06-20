# Stream Summary Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a streamer's Bilibili live ends, post one end-of-stream summary notification (chat, audience, monetary, per-user highlights) to that room's Telegram channel.

**Architecture:** A single new file `src/streamSummary.ts` holds three isolated units — `SessionStats` (pure in-RAM accumulator per stream), `SessionManager` (a per-room `IDLE`/`LIVE`/`ENDING` state machine with a debounce timer, robust to Bilibili's repeated lifecycle events), and `formatSummary` (pure renderer). `src/index.ts` wires one `SessionManager` into the existing event handler and emits summaries via Telegram. No database, no persistence, no new dependencies.

**Tech Stack:** Bun, TypeScript (strict), `@laplace.live/event-types` (types only), `@mtcute/bun` (existing Telegram client).

## Global Constraints

Every task implicitly includes these (verbatim from the spec):

- Runtime is **Bun**: tests run with `bun test`; typecheck with `bunx tsc`; never `node`/`jest`/`ts-node`.
- **No database, no persistence, no new dependencies.** Metrics live in RAM and are lost on restart (accepted).
- **No new config fields.** `src/types.ts` and `config.yaml` are unchanged; the feature is always on for every configured room.
- Debounce default: **`STREAM_SUMMARY_DEBOUNCE_MS = 45_000`** ms.
- Gift revenue counts **gold (paid) gifts only** (`coinType === 'gold'`).
- New follows = `interaction.action === 2 || event.action === 4`.
- Summary posts to **`room.telegram_announce_ch`** (same channel as the existing 开播/下播 messages).
- Money values are `priceNormalized` (already CNY); render with thousands separators and up to 1 decimal. Counts render with thousands separators. Clock times render in **`Asia/Shanghai`**.
- TypeScript: `strict`, `noUncheckedIndexedAccess` (Map/array access is `T | undefined` — handle it), `verbatimModuleSyntax` (type-only imports MUST use `import type`), `noFallthroughCasesInSwitch` (every `case` ends in `return`/`break`).

## File Structure

- `src/utils.ts` — **modify**: add `formatDuration(ms)`.
- `src/consts.ts` — **modify**: add `STREAM_SUMMARY_DEBOUNCE_MS`.
- `src/streamSummary.ts` — **create**: `StreamSummary` type, `SessionStats`, `formatSummary`, `SessionManager`.
- `src/index.ts` — **modify**: instantiate `SessionManager`, route events to it, clear timers on SIGINT.
- `src/utils.test.ts` — **create**: tests for `formatDuration`.
- `src/streamSummary.test.ts` — **create**: tests for `SessionStats`, `formatSummary`, `SessionManager`.
- `README.md` — **modify**: document the feature + multi-bridge caveat.

---

## Setup: feature branch

The repo is currently on the default branch `master`. Create a working branch before Task 1.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/stream-summary
```

---

### Task 1: `formatDuration` helper

**Files:**
- Modify: `src/utils.ts`
- Test: `src/utils.test.ts` (create)

**Interfaces:**
- Produces: `formatDuration(ms: number): string` — `"3小时42分"`, `"42分"`, `"3小时"`, `"0分"`.

- [ ] **Step 1: Write the failing test**

Create `src/utils.test.ts`:

```ts
import { expect, test } from 'bun:test'

import { formatDuration } from './utils'

test('formatDuration: hours and minutes', () => {
  expect(formatDuration((3 * 60 + 42) * 60_000)).toBe('3小时42分')
})

test('formatDuration: minutes only', () => {
  expect(formatDuration(42 * 60_000)).toBe('42分')
})

test('formatDuration: whole hours', () => {
  expect(formatDuration(3 * 3_600_000)).toBe('3小时')
})

test('formatDuration: zero', () => {
  expect(formatDuration(0)).toBe('0分')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils.test.ts`
Expected: FAIL — `formatDuration` is not exported from `./utils`.

- [ ] **Step 3: Implement the helper**

Append to `src/utils.ts`:

```ts
/** Format a duration in milliseconds as a short zh-CN string, e.g. "3小时42分". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours > 0 && minutes > 0) return `${hours}小时${minutes}分`
  if (hours > 0) return `${hours}小时`
  return `${minutes}分`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils.ts src/utils.test.ts
git commit -m "feat: add formatDuration helper"
```

---

### Task 2: `SessionStats` accumulator + `StreamSummary` type

**Files:**
- Create: `src/streamSummary.ts`
- Test: `src/streamSummary.test.ts` (create)

**Interfaces:**
- Consumes: `LaplaceEvent` (type) from `@laplace.live/event-types`.
- Produces:
  - `interface StreamSummary` with fields: `startedAt, endedAt, durationMs, partial: boolean, chats, uniqueChatters, watchedMax, onlinePeak, likesMax, newFollows: number; gifts/sc/guards: { count: number; revenue: number }; totalRevenue: number; topGifter: { uid; name; total } | null; biggestSc: { uid; name; amount; message } | null; topChatter: { uid; name; count } | null`.
  - `class SessionStats` with `readonly startedAt: number`, `readonly partial: boolean`, constructor `(startedAt: number, partial: boolean)`, `record(event: LaplaceEvent): void`, `finalize(endedAt: number): StreamSummary`.
  - `const RECORDABLE_TYPES: Set<string>` (used by Task 4).

- [ ] **Step 1: Write the failing test**

Create `src/streamSummary.test.ts`:

```ts
import { expect, test } from 'bun:test'

import type { LaplaceEvent } from '@laplace.live/event-types'

import { SessionStats } from './streamSummary'

/** Build a minimal synthetic event for tests (fields not under test are stubbed). */
function ev(type: string, extra: Record<string, unknown>): LaplaceEvent {
  return {
    type,
    id: 'x',
    origin: 100,
    originIdx: 0,
    uid: 0,
    username: 'u',
    message: '',
    timestamp: 0,
    timestampNormalized: 0,
    read: false,
    ...extra,
  } as unknown as LaplaceEvent
}

test('SessionStats accumulates a full event sequence', () => {
  const stats = new SessionStats(1_000, false)

  // chats: uid 1 twice, uid 2 once
  stats.record(ev('message', { uid: 1, username: 'a' }))
  stats.record(ev('message', { uid: 1, username: 'a' }))
  stats.record(ev('message', { uid: 2, username: 'b' }))

  // peaks / maxes (cumulative metrics)
  stats.record(ev('watched-update', { watched: 100 }))
  stats.record(ev('watched-update', { watched: 250 }))
  stats.record(ev('watched-update', { watched: 200 }))
  stats.record(ev('online-update', { online: 50 }))
  stats.record(ev('online-update', { online: 80 }))
  stats.record(ev('likes-update', { likes: 1_000 }))
  stats.record(ev('likes-update', { likes: 3_000 }))

  // follows: action 2 and 4 count, action 1 (enter) does not
  stats.record(ev('interaction', { action: 2 }))
  stats.record(ev('interaction', { action: 1 }))
  stats.record(ev('interaction', { action: 4 }))

  // gifts: gold counts, silver excluded; top gifter is uid 2
  stats.record(ev('gift', { uid: 1, username: 'a', coinType: 'gold', priceNormalized: 10 }))
  stats.record(ev('gift', { uid: 2, username: 'b', coinType: 'gold', priceNormalized: 30 }))
  stats.record(ev('gift', { uid: 1, username: 'a', coinType: 'silver', priceNormalized: 5 }))

  // super chats: biggest is uid 1 at 100
  stats.record(ev('superchat', { uid: 3, username: 'c', priceNormalized: 50, message: 'hi' }))
  stats.record(ev('superchat', { uid: 1, username: 'a', priceNormalized: 100, message: 'yo' }))

  // guards
  stats.record(ev('toast', { uid: 2, username: 'b', priceNormalized: 198 }))
  stats.record(ev('toast', { uid: 3, username: 'c', priceNormalized: 198 }))

  // ignored noise
  stats.record(ev('room-name-update', {}))

  const s = stats.finalize(1_000 + 13_320_000) // +3h42m

  expect(s.durationMs).toBe(13_320_000)
  expect(s.partial).toBe(false)
  expect(s.chats).toBe(3)
  expect(s.uniqueChatters).toBe(2)
  expect(s.watchedMax).toBe(250)
  expect(s.onlinePeak).toBe(80)
  expect(s.likesMax).toBe(3_000)
  expect(s.newFollows).toBe(2)
  expect(s.gifts).toEqual({ count: 2, revenue: 40 })
  expect(s.sc).toEqual({ count: 2, revenue: 150 })
  expect(s.guards).toEqual({ count: 2, revenue: 396 })
  expect(s.totalRevenue).toBe(586)
  expect(s.topGifter).toEqual({ uid: 2, name: 'b', total: 30 })
  expect(s.biggestSc).toEqual({ uid: 1, name: 'a', amount: 100, message: 'yo' })
  expect(s.topChatter).toEqual({ uid: 1, name: 'a', count: 2 })
})

test('SessionStats with no activity yields empty summary', () => {
  const s = new SessionStats(1_000, false).finalize(2_000)
  expect(s.chats).toBe(0)
  expect(s.uniqueChatters).toBe(0)
  expect(s.totalRevenue).toBe(0)
  expect(s.topGifter).toBeNull()
  expect(s.biggestSc).toBeNull()
  expect(s.topChatter).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/streamSummary.test.ts`
Expected: FAIL — cannot find module `./streamSummary` / `SessionStats` not exported.

- [ ] **Step 3: Implement `SessionStats`**

Create `src/streamSummary.ts`:

```ts
import type { LaplaceEvent } from '@laplace.live/event-types'

export interface StreamSummary {
  startedAt: number
  endedAt: number
  durationMs: number
  /** true when no live-start was observed (bot started mid-stream); numbers are a lower bound. */
  partial: boolean
  chats: number
  uniqueChatters: number
  watchedMax: number
  onlinePeak: number
  likesMax: number
  newFollows: number
  gifts: { count: number; revenue: number }
  sc: { count: number; revenue: number }
  guards: { count: number; revenue: number }
  totalRevenue: number
  topGifter: { uid: number; name: string; total: number } | null
  biggestSc: { uid: number; name: string; amount: number; message: string } | null
  topChatter: { uid: number; name: string; count: number } | null
}

/** Event types that contribute to a stream summary. */
export const RECORDABLE_TYPES = new Set<string>([
  'message',
  'watched-update',
  'online-update',
  'likes-update',
  'interaction',
  'gift',
  'superchat',
  'toast',
])

/** In-memory accumulator for a single live session. Pure: no I/O. */
export class SessionStats {
  readonly startedAt: number
  readonly partial: boolean

  private chats = 0
  private readonly chatters = new Map<number, { name: string; count: number }>()
  private watchedMax = 0
  private onlinePeak = 0
  private likesMax = 0
  private newFollows = 0
  private giftCount = 0
  private giftRevenue = 0
  private scCount = 0
  private scRevenue = 0
  private guardCount = 0
  private guardRevenue = 0
  private readonly gifters = new Map<number, { name: string; total: number }>()
  private biggestSc: { uid: number; name: string; amount: number; message: string } | null = null

  constructor(startedAt: number, partial: boolean) {
    this.startedAt = startedAt
    this.partial = partial
  }

  record(event: LaplaceEvent): void {
    switch (event.type) {
      case 'message': {
        this.chats++
        const c = this.chatters.get(event.uid)
        if (c) c.count++
        else this.chatters.set(event.uid, { name: event.username, count: 1 })
        break
      }
      case 'watched-update':
        if (event.watched > this.watchedMax) this.watchedMax = event.watched
        break
      case 'online-update':
        if (event.online > this.onlinePeak) this.onlinePeak = event.online
        break
      case 'likes-update':
        if (event.likes > this.likesMax) this.likesMax = event.likes
        break
      case 'interaction':
        if (event.action === 2 || event.action === 4) this.newFollows++
        break
      case 'gift':
        if (event.coinType === 'gold') {
          this.giftCount++
          this.giftRevenue += event.priceNormalized
          const g = this.gifters.get(event.uid)
          if (g) g.total += event.priceNormalized
          else this.gifters.set(event.uid, { name: event.username, total: event.priceNormalized })
        }
        break
      case 'superchat':
        this.scCount++
        this.scRevenue += event.priceNormalized
        if (!this.biggestSc || event.priceNormalized > this.biggestSc.amount) {
          this.biggestSc = {
            uid: event.uid,
            name: event.username,
            amount: event.priceNormalized,
            message: event.message,
          }
        }
        break
      case 'toast':
        this.guardCount++
        this.guardRevenue += event.priceNormalized
        break
      default:
        break
    }
  }

  finalize(endedAt: number): StreamSummary {
    let topChatter: StreamSummary['topChatter'] = null
    for (const [uid, v] of this.chatters) {
      if (!topChatter || v.count > topChatter.count) {
        topChatter = { uid, name: v.name, count: v.count }
      }
    }

    let topGifter: StreamSummary['topGifter'] = null
    for (const [uid, v] of this.gifters) {
      if (!topGifter || v.total > topGifter.total) {
        topGifter = { uid, name: v.name, total: v.total }
      }
    }

    return {
      startedAt: this.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - this.startedAt),
      partial: this.partial,
      chats: this.chats,
      uniqueChatters: this.chatters.size,
      watchedMax: this.watchedMax,
      onlinePeak: this.onlinePeak,
      likesMax: this.likesMax,
      newFollows: this.newFollows,
      gifts: { count: this.giftCount, revenue: this.giftRevenue },
      sc: { count: this.scCount, revenue: this.scRevenue },
      guards: { count: this.guardCount, revenue: this.guardRevenue },
      totalRevenue: this.giftRevenue + this.scRevenue + this.guardRevenue,
      topGifter,
      biggestSc: this.biggestSc,
      topChatter,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/streamSummary.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/streamSummary.ts src/streamSummary.test.ts
git commit -m "feat: add SessionStats stream metrics accumulator"
```

---

### Task 3: `formatSummary` renderer

**Files:**
- Modify: `src/streamSummary.ts`
- Test: `src/streamSummary.test.ts` (append)

**Interfaces:**
- Consumes: `StreamSummary` (Task 2), `RoomConfig` (type) from `./types`, `formatDuration` (Task 1).
- Produces: `formatSummary(summary: StreamSummary, room: RoomConfig): string`.

- [ ] **Step 1: Write the failing test**

Append to `src/streamSummary.test.ts`:

```ts
import type { RoomConfig } from './types'

import { formatSummary } from './streamSummary'

const room = { slug: '测试', telegram_announce_ch: 1, telegram_watchers_ch: 1 } as unknown as RoomConfig

function baseSummary(): import('./streamSummary').StreamSummary {
  return {
    startedAt: 0,
    endedAt: 13_320_000,
    durationMs: 13_320_000,
    partial: false,
    chats: 3,
    uniqueChatters: 2,
    watchedMax: 250,
    onlinePeak: 80,
    likesMax: 3_000,
    newFollows: 2,
    gifts: { count: 2, revenue: 1_240.5 },
    sc: { count: 2, revenue: 980 },
    guards: { count: 2, revenue: 597 },
    totalRevenue: 2_817.5,
    topGifter: { uid: 2, name: 'b', total: 680 },
    biggestSc: { uid: 1, name: 'a', amount: 500, message: 'yo' },
    topChatter: { uid: 1, name: 'a', count: 142 },
  }
}

test('formatSummary renders all sections', () => {
  const out = formatSummary(baseSummary(), room)
  expect(out).toContain('#直播总结')
  expect(out).toContain('测试')
  expect(out).toContain('时长 3小时42分')
  expect(out).toContain('总收入 ¥2,817.5')
  expect(out).toContain('🎁 礼物 2 ¥1,240.5')
  expect(out).toContain('💌 醒目留言 2 ¥980')
  expect(out).toContain('⚓ 大航海 2 ¥597')
  expect(out).toContain('看过 250')
  expect(out).toContain('峰值在线 80')
  expect(out).toContain('点赞 3,000')
  expect(out).toContain('新增关注 2')
  expect(out).toContain('弹幕 3')
  expect(out).toContain('发言 2 人')
  expect(out).toContain('最佳金主 b ¥680')
  expect(out).toContain('最高 SC a ¥500')
  expect(out).toContain('最活跃 a 142 条')
})

test('formatSummary omits empty sections', () => {
  const s = baseSummary()
  s.gifts = { count: 0, revenue: 0 }
  s.sc = { count: 0, revenue: 0 }
  s.guards = { count: 0, revenue: 0 }
  s.totalRevenue = 0
  s.topGifter = null
  s.biggestSc = null
  const out = formatSummary(s, room)
  expect(out).not.toContain('总收入')
  expect(out).not.toContain('最佳金主')
  expect(out).not.toContain('最高 SC')
  expect(out).toContain('#直播总结')
  expect(out).toContain('弹幕 3')
})

test('formatSummary marks partial sessions', () => {
  const s = baseSummary()
  s.partial = true
  expect(formatSummary(s, room)).toContain('⚠️ 部分数据')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/streamSummary.test.ts`
Expected: FAIL — `formatSummary` not exported.

- [ ] **Step 3: Implement `formatSummary`**

Add to `src/streamSummary.ts`. Update the top type-only import line to include `RoomConfig`, add the value import for `formatDuration`, and append the functions:

```ts
// at the top, alongside the existing imports:
import type { RoomConfig } from './types'

import { formatDuration } from './utils'
```

```ts
// appended below SessionStats:

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

function clock(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ts)
}

/** Render a StreamSummary as a Telegram markdown message. Pure. */
export function formatSummary(s: StreamSummary, room: RoomConfig): string {
  const blocks: string[] = []

  let header = `#直播总结 📊 ${room.slug}`
  if (s.partial) header = `⚠️ 部分数据（监控中途启动）\n${header}`
  blocks.push(header)

  blocks.push(`🕐 时长 ${formatDuration(s.durationMs)}  ·  ${clock(s.startedAt)} → ${clock(s.endedAt)}`)

  const money: string[] = []
  if (s.gifts.count > 0) money.push(`   🎁 礼物 ${fmtNum(s.gifts.count)} ¥${fmtMoney(s.gifts.revenue)}`)
  if (s.sc.count > 0) money.push(`   💌 醒目留言 ${fmtNum(s.sc.count)} ¥${fmtMoney(s.sc.revenue)}`)
  if (s.guards.count > 0) money.push(`   ⚓ 大航海 ${fmtNum(s.guards.count)} ¥${fmtMoney(s.guards.revenue)}`)
  if (money.length > 0) {
    blocks.push([`💰 总收入 ¥${fmtMoney(s.totalRevenue)}`, ...money].join('\n'))
  }

  const audience: string[] = []
  if (s.watchedMax > 0) audience.push(`👥 看过 ${fmtNum(s.watchedMax)}`)
  if (s.onlinePeak > 0) audience.push(`🟢 峰值在线 ${fmtNum(s.onlinePeak)}`)
  if (s.likesMax > 0) audience.push(`👍 点赞 ${fmtNum(s.likesMax)}`)
  if (s.newFollows > 0) audience.push(`➕ 新增关注 ${fmtNum(s.newFollows)}`)
  if (audience.length > 0) blocks.push(audience.join('  ·  '))

  const chat: string[] = [`💬 弹幕 ${fmtNum(s.chats)}`]
  if (s.uniqueChatters > 0) chat.push(`🗣️ 发言 ${fmtNum(s.uniqueChatters)} 人`)
  blocks.push(chat.join('  ·  '))

  const highlights: string[] = []
  if (s.topGifter) highlights.push(`🏆 最佳金主 ${s.topGifter.name} ¥${fmtMoney(s.topGifter.total)}`)
  if (s.biggestSc) highlights.push(`🔥 最高 SC ${s.biggestSc.name} ¥${fmtMoney(s.biggestSc.amount)}`)
  if (s.topChatter) highlights.push(`⚡ 最活跃 ${s.topChatter.name} ${fmtNum(s.topChatter.count)} 条`)
  if (highlights.length > 0) blocks.push(highlights.join('\n'))

  return blocks.join('\n\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/streamSummary.test.ts`
Expected: PASS (all `streamSummary` tests, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/streamSummary.ts src/streamSummary.test.ts
git commit -m "feat: add formatSummary renderer"
```

---

### Task 4: `SessionManager` lifecycle state machine

**Files:**
- Modify: `src/streamSummary.ts`
- Test: `src/streamSummary.test.ts` (append)

**Interfaces:**
- Consumes: `SessionStats` (Task 2), `RECORDABLE_TYPES` (Task 2), `StreamSummary` (Task 2), `LaplaceEvent` (type).
- Produces:
  - `interface SessionManagerOptions { debounceMs: number; onSummary: (roomId: number, summary: StreamSummary) => void | Promise<void> }`
  - `class SessionManager` with `constructor(opts: SessionManagerOptions)`, `handle(roomId: number, event: LaplaceEvent): void`, `clearAllTimers(): void`.

- [ ] **Step 1: Write the failing test**

Append to `src/streamSummary.test.ts` (reuses the `ev()` helper defined in Task 2):

```ts
import { SessionManager } from './streamSummary'
import type { StreamSummary } from './streamSummary'

function makeManager() {
  const calls: Array<{ roomId: number; summary: StreamSummary }> = []
  const manager = new SessionManager({
    debounceMs: 30,
    onSummary: (roomId, summary) => {
      calls.push({ roomId, summary })
    },
  })
  return { calls, manager }
}

test('SessionManager: emits one summary after a normal stream', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  manager.handle(100, ev('message', { uid: 1, username: 'a' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]!.roomId).toBe(100)
  expect(calls[0]!.summary.chats).toBe(1)
  expect(calls[0]!.summary.endedAt).toBe(2_000)
  expect(calls[0]!.summary.partial).toBe(false)
})

test('SessionManager: ignores duplicate live-start bursts (no reset)', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  manager.handle(100, ev('message', { uid: 1, username: 'a' }))
  manager.handle(100, ev('live-start', { timestampNormalized: 1_001 })) // duplicate
  manager.handle(100, ev('message', { uid: 2, username: 'b' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]!.summary.chats).toBe(2)
  expect(calls[0]!.summary.startedAt).toBe(1_000)
})

test('SessionManager: collapses duplicate live-end bursts into one summary', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  manager.handle(100, ev('message', { uid: 1, username: 'a' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_001 })) // duplicate burst
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]!.summary.endedAt).toBe(2_001)
})

test('SessionManager: a brief end->start flap is one continuous stream', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  manager.handle(100, ev('message', { uid: 1, username: 'a' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 })) // blip
  manager.handle(100, ev('live-start', { timestampNormalized: 2_010 })) // resume within window
  manager.handle(100, ev('message', { uid: 2, username: 'b' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 3_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]!.summary.chats).toBe(2)
  expect(calls[0]!.summary.startedAt).toBe(1_000)
  expect(calls[0]!.summary.endedAt).toBe(3_000)
})

test('SessionManager: events without a live-start produce a partial summary', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 5_000 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 6_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]!.summary.partial).toBe(true)
  expect(calls[0]!.summary.startedAt).toBe(5_000)
})

test('SessionManager: live-end with no session is ignored', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('live-end', { timestampNormalized: 6_000 }))
  await Bun.sleep(60)
  expect(calls.length).toBe(0)
})

test('SessionManager: clearAllTimers cancels a pending summary', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  manager.clearAllTimers()
  await Bun.sleep(60)
  expect(calls.length).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/streamSummary.test.ts`
Expected: FAIL — `SessionManager` not exported.

- [ ] **Step 3: Implement `SessionManager`**

Append to `src/streamSummary.ts`:

```ts
export interface SessionManagerOptions {
  debounceMs: number
  onSummary: (roomId: number, summary: StreamSummary) => void | Promise<void>
}

/**
 * Per-room lifecycle state machine for stream summaries.
 *
 * State is derived from two maps: a room with a session is LIVE (no timer) or
 * ENDING (timer pending); a room with no session is IDLE. This makes the
 * manager idempotent against Bilibili's repeated live-start/live-end events.
 */
export class SessionManager {
  private readonly debounceMs: number
  private readonly onSummary: (roomId: number, summary: StreamSummary) => void | Promise<void>
  private readonly sessions = new Map<number, SessionStats>()
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly pendingEndAt = new Map<number, number>()

  constructor(opts: SessionManagerOptions) {
    this.debounceMs = opts.debounceMs
    this.onSummary = opts.onSummary
  }

  handle(roomId: number, event: LaplaceEvent): void {
    switch (event.type) {
      case 'live-start': {
        const timer = this.timers.get(roomId)
        if (timer) {
          // ENDING -> resume: brief blip, keep counting the same session
          clearTimeout(timer)
          this.timers.delete(roomId)
          this.pendingEndAt.delete(roomId)
        } else if (!this.sessions.has(roomId)) {
          // IDLE -> start a new session
          this.sessions.set(roomId, new SessionStats(event.timestampNormalized, false))
        }
        // else LIVE duplicate -> ignore (do not reset stats)
        return
      }
      case 'live-end': {
        if (!this.sessions.has(roomId)) return // IDLE -> nothing to end
        this.pendingEndAt.set(roomId, event.timestampNormalized)
        const existing = this.timers.get(roomId)
        if (existing) clearTimeout(existing)
        this.timers.set(
          roomId,
          setTimeout(() => this.finalizeRoom(roomId), this.debounceMs),
        )
        return
      }
      default: {
        if (!RECORDABLE_TYPES.has(event.type)) return
        let session = this.sessions.get(roomId)
        if (!session) {
          // Bot started mid-stream: no live-start was seen -> partial session
          session = new SessionStats(event.timestampNormalized, true)
          this.sessions.set(roomId, session)
        }
        session.record(event)
        return
      }
    }
  }

  /** Cancel all pending debounce timers (e.g. on shutdown). */
  clearAllTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private finalizeRoom(roomId: number): void {
    const session = this.sessions.get(roomId)
    const endedAt = this.pendingEndAt.get(roomId)
    this.timers.delete(roomId)
    this.pendingEndAt.delete(roomId)
    this.sessions.delete(roomId)
    if (!session || endedAt === undefined) return

    const summary = session.finalize(endedAt)
    Promise.resolve(this.onSummary(roomId, summary)).catch(err =>
      console.error(`[summary] onSummary failed for room ${roomId}:`, err),
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/streamSummary.test.ts`
Expected: PASS (all `streamSummary` tests including the 7 new SessionManager tests).

- [ ] **Step 5: Typecheck the new module**

Run: `bunx tsc`
Expected: no errors, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/streamSummary.ts src/streamSummary.test.ts
git commit -m "feat: add SessionManager debounced lifecycle state machine"
```

---

### Task 5: Wire into the bot + config const + docs

**Files:**
- Modify: `src/consts.ts`
- Modify: `src/index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `SessionManager`, `formatSummary` (Tasks 2–4); `STREAM_SUMMARY_DEBOUNCE_MS` (this task).
- Produces: end-to-end behavior. No new exported API.

This task has no unit test (it wires top-level bot startup that requires live Telegram/WebSocket credentials). It is verified by the full test suite, typecheck, lint, and a manual smoke note.

- [ ] **Step 1: Add the debounce constant**

Append to `src/consts.ts`:

```ts
/**
 * Debounce window (ms) before emitting an end-of-stream summary.
 *
 * Bilibili fires live-start/live-end repeatedly (often several times within
 * ~3s) and flaps end->start on brief encoder/network blips. This window
 * collapses those bursts into a single logical stream and a single summary.
 */
export const STREAM_SUMMARY_DEBOUNCE_MS = 45_000
```

- [ ] **Step 2: Import the new units in `src/index.ts`**

In `src/index.ts`, update the consts import (currently `import { EMOJI_MAP, GUARD_TYPE_DICT, PRICE_TIER_EMOJI, SUPERCHAT_TIER_EMOJI } from './consts'`) to also import the new constant, and add an import for the summary module after the existing `./eventStore` import:

```ts
import { EMOJI_MAP, GUARD_TYPE_DICT, PRICE_TIER_EMOJI, STREAM_SUMMARY_DEBOUNCE_MS, SUPERCHAT_TIER_EMOJI } from './consts'
import { EventStore, formatMessagesContext } from './eventStore'
import { SessionManager, formatSummary } from './streamSummary'
```

- [ ] **Step 3: Instantiate the SessionManager**

In `src/index.ts`, immediately after the `tg` client is constructed (the `const tg = new TelegramClient({ ... })` block), add:

```ts
// Stream summary: accumulate per-room metrics and emit a summary after each stream
const summaryManager = new SessionManager({
  debounceMs: STREAM_SUMMARY_DEBOUNCE_MS,
  onSummary: async (roomId, summary) => {
    const room = roomMap.get(roomId)
    if (!room) return
    const message = formatSummary(summary, room)
    try {
      await tg.sendText(room.telegram_announce_ch, md(message), { disableWebPreview: true })
      console.log(`[summary] Sent stream summary for ${room.slug} (${roomId})`)
    } catch (err) {
      console.error(`[summary] Failed to send summary for ${room.slug} (${roomId}):`, err)
    }
  },
})
```

- [ ] **Step 4: Route events into the manager**

In `src/index.ts`, inside `handleEvent`, after the bridge-specific skip check (the block ending `console.log(...'skipping')...return }` around line 89) and before the `// Store only message events...` block, add:

```ts
  // Accumulate metrics for the end-of-stream summary (respects the same
  // single-bridge dedup as notifications above)
  summaryManager.handle(roomId, event)
```

- [ ] **Step 5: Clear timers on shutdown**

In `src/index.ts`, inside the `process.on('SIGINT', ...)` handler, after the `console.log('\nShutting down...')` line, add:

```ts
  // Cancel any pending summary timers (in-memory data is discarded on shutdown)
  summaryManager.clearAllTimers()
```

- [ ] **Step 6: Align tsconfig, then verify the whole suite + types + lint**

First make `tsc` a clean gate. The `references/` directory holds scratch reference scripts that are **not** part of the build (the Dockerfile copies only `src/`) and carry pre-existing type errors. Biome already excludes it (`biome.jsonc` `includes` has `!references`) but `tsconfig.json` does not, so a bare `bunx tsc` fails on that pre-existing noise. Add a matching `exclude` as a sibling of `compilerOptions` in `tsconfig.json` (the file currently has only a `compilerOptions` object — add the new top-level key after it):

```jsonc
  "exclude": ["node_modules", "references"]
```

Then run, in order:

Run: `bun test`
Expected: PASS — all tests in `src/utils.test.ts` and `src/streamSummary.test.ts`.

Run: `bunx tsc`
Expected: no errors, exit code 0 (`references/` is now excluded; `src/` was already clean).

Run: `bun run lint`
Expected: Biome reports no errors. Tasks 3–4 appended `import` lines mid-file in `src/streamSummary.test.ts`; if Biome flags import organization or formatting, run `bun run format`, then re-run `bun run lint`, and re-stage.

- [ ] **Step 7: Document the feature in `README.md`**

In `README.md`, add a bullet to the `## Features` list:

```markdown
- End-of-stream summary notifications (chat, audience, revenue, highlights)
```

And add this section immediately before `## Prerequisites`:

```markdown
## Stream Summary

When a monitored stream ends, the bot posts a single summary to the room's
`telegram_announce_ch` with the stream's duration, chat activity, audience
(看过 / peak online / likes / new follows), monetary totals (gifts, super
chats, 大航海), and per-user highlights (top gifter, biggest super chat, most
active chatter).

Metrics are accumulated **in memory** — there is no database, and an in-progress
stream's totals are lost if the process restarts. Bilibili fires
`live-start`/`live-end` repeatedly and flaps on brief drops, so the summary is
sent after a debounce window (`STREAM_SUMMARY_DEBOUNCE_MS`, default 45s) once the
stream has truly ended.

> **Multi-bridge note:** counts assume each room is pinned to a single `bridge`.
> If a room is monitored by multiple bridges, duplicate events will inflate the
> summary — pin the room to one bridge (as you already do to avoid duplicate
> notifications).
```

- [ ] **Step 8: Commit**

```bash
git add src/consts.ts src/index.ts tsconfig.json README.md
git commit -m "feat: emit end-of-stream summary notifications"
```

---

## Self-Review

**Spec coverage:**
- In-memory, no DB, no persistence → `SessionStats` (RAM only); no storage code. ✅
- No new config fields → `types.ts`/`config.yaml` untouched; debounce is a const. ✅
- Debounce 45s + robust to repeated live-start/live-end → `SessionManager` state machine + `STREAM_SUMMARY_DEBOUNCE_MS`; Task 4 tests cover burst dedup, continuation, single-emit. ✅
- Metrics: monetary / audience / chat / highlights + duration → `SessionStats.record`/`finalize`; Task 2 test asserts all. ✅
- Gold-only gift revenue; follows = action 2/4 → implemented and asserted. ✅
- Summary to `telegram_announce_ch`; project style → `formatSummary` + Task 5 onSummary. ✅
- Partial (mid-stream start) labeled → `partial` flag, `⚠️` marker; Task 3 + Task 4 tests. ✅
- SIGINT clears timers → Task 5 Step 5. ✅
- Multi-bridge caveat + deleted-SC limitation → README (Task 5) / accepted in spec. ✅

**Placeholder scan:** No TBD/TODO; every code step contains full code; every command has expected output. ✅

**Type consistency:** `handle()`, `clearAllTimers()`, `record()`, `finalize()`, `formatSummary()`, `formatDuration()`, `StreamSummary`, `SessionManagerOptions`, `RECORDABLE_TYPES`, `STREAM_SUMMARY_DEBOUNCE_MS` are used with identical names/signatures across tasks and call sites. `onSummary(roomId, summary)` matches between `SessionManager` and the `index.ts` callback. ✅
