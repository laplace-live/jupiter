import { expect, test } from 'bun:test'
import type { LaplaceEvent } from '@laplace.live/event-types'
import { md } from '@mtcute/markdown-parser'

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

  // gifts: gold counts toward spend, silver excluded
  stats.record(ev('gift', { uid: 1, username: 'a', coinType: 'gold', priceNormalized: 10 }))
  stats.record(ev('gift', { uid: 2, username: 'b', coinType: 'gold', priceNormalized: 30 }))
  stats.record(ev('gift', { uid: 1, username: 'a', coinType: 'silver', priceNormalized: 5 }))

  // super chats: add to spend (uid 1 +100, uid 3 +50)
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
  expect(s.chatsPerCapita).toBe(1.5)
  expect(s.watchedMax).toBe(250)
  expect(s.onlinePeak).toBe(80)
  expect(s.avgOnline).toBe(65) // mean of online samples 50 and 80
  expect(s.likesMax).toBe(3_000)
  expect(s.newFollows).toBe(2)
  expect(s.gifts).toEqual({ count: 2, revenue: 40 })
  expect(s.sc).toEqual({ count: 2, revenue: 150 })
  expect(s.guards).toEqual({ count: 2, revenue: 396 })
  expect(s.totalRevenue).toBe(586)
  expect(s.hourlyRevenue).toBeCloseTo(158.378, 2) // 586 revenue over 3.7h
  // 金主榜 = total normalized spend per uid: c=50+198=248, b=30+198=228, a=10+100=110
  expect(s.topSpenders).toEqual([
    { uid: 3, name: 'c', total: 248 },
    { uid: 2, name: 'b', total: 228 },
    { uid: 1, name: 'a', total: 110 },
  ])
  expect(s.topChatters).toEqual([
    { uid: 1, name: 'a', count: 2 },
    { uid: 2, name: 'b', count: 1 },
  ])
})

test('SessionStats with no activity yields empty summary', () => {
  const s = new SessionStats(1_000, false).finalize(2_000)
  expect(s.chats).toBe(0)
  expect(s.uniqueChatters).toBe(0)
  expect(s.chatsPerCapita).toBe(0)
  expect(s.avgOnline).toBe(0)
  expect(s.totalRevenue).toBe(0)
  expect(s.hourlyRevenue).toBe(0)
  expect(s.topSpenders).toEqual([])
  expect(s.topChatters).toEqual([])
})

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
    chatsPerCapita: 1.5,
    watchedMax: 250,
    onlinePeak: 80,
    avgOnline: 72,
    likesMax: 3_000,
    newFollows: 2,
    gifts: { count: 2, revenue: 1_240.5 },
    sc: { count: 2, revenue: 980 },
    guards: { count: 2, revenue: 597 },
    totalRevenue: 2_817.5,
    hourlyRevenue: 761.5,
    topSpenders: [
      { uid: 2, name: 'b', total: 680 },
      { uid: 3, name: 'c', total: 120 },
    ],
    topChatters: [
      { uid: 1, name: 'a', count: 142 },
      { uid: 5, name: 'e', count: 30 },
    ],
  }
}

test('formatSummary renders all sections', () => {
  const out = formatSummary(baseSummary(), room)
  expect(out).toContain('#直播总结')
  expect(out).toContain('测试')
  expect(out).toContain('时长 3小时42分')
  expect(out).toContain('总收入 ¥2,817.5')
  expect(out).toContain('🎁 礼物 2 - ¥1,240.5')
  expect(out).toContain('💌 醒目留言 2 - ¥980')
  expect(out).toContain('⚓ 大航海 2 - ¥597')
  expect(out).toContain('💵 时薪 ¥761.5')
  expect(out).toContain('看过 250')
  expect(out).toContain('峰值同接 80')
  expect(out).toContain('📊 平均同接 72')
  expect(out).toContain('点赞 3,000')
  expect(out).toContain('新增关注 2')
  expect(out).toContain('弹幕 3')
  expect(out).toContain('发言 2 人')
  expect(out).toContain('📈 人均弹幕 1.5 条')
  // derived metrics sit at the end of their source block, each on its own line
  expect(out).toContain('⚓ 大航海 2 - ¥597\n💵 时薪 ¥761.5')
  expect(out).toContain('👥 看过 250\n🟢 峰值同接 80\n📊 平均同接 72\n👍 点赞 3,000\n➕ 新增关注 2')
  expect(out).toContain('💬 弹幕 3\n🗣️ 发言 2 人\n📈 人均弹幕 1.5 条')
  expect(out).toContain('🏆 金主榜\n1. b ¥680\n2. c ¥120')
  expect(out).not.toContain('SC 榜') // SC leaderboard removed
  expect(out).toContain('⚡ 弹幕榜\n1. a 142 条\n2. e 30 条')
})

test('formatSummary omits empty sections', () => {
  const s = baseSummary()
  s.gifts = { count: 0, revenue: 0 }
  s.sc = { count: 0, revenue: 0 }
  s.guards = { count: 0, revenue: 0 }
  s.totalRevenue = 0
  s.topSpenders = []
  const out = formatSummary(s, room)
  expect(out).not.toContain('总收入')
  expect(out).not.toContain('时薪')
  expect(out).not.toContain('金主榜')
  expect(out).toContain('#直播总结')
  expect(out).toContain('弹幕 3')
})

test('formatSummary marks partial sessions', () => {
  const s = baseSummary()
  s.partial = true
  expect(formatSummary(s, room)).toContain('⚠️ 部分数据')
})

test('formatSummary applies the escaper to viewer-supplied name fields', () => {
  const s = baseSummary()
  const out = formatSummary(s, room, t => `⟦${t}⟧`)
  expect(out).toContain('1. ⟦b⟧ ¥680') // top spender name escaped
  expect(out).toContain('1. ⟦a⟧ 142 条') // top chatter name escaped
  expect(out).toContain('¥680') // amounts are not escaped
})

test('formatSummary output stays valid markdown even with hostile text', () => {
  const s = baseSummary()
  s.topSpenders = [{ uid: 2, name: '**b', total: 680 }]
  s.topChatters = [{ uid: 1, name: '[a](x)', count: 5 }]
  const out = formatSummary(s, room, md.escape)
  expect(() => md(out)).not.toThrow()
})

import type { StreamSummary } from './streamSummary'

import { SessionManager } from './streamSummary'

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
  expect(calls[0]?.roomId).toBe(100)
  expect(calls[0]?.summary.chats).toBe(1)
  expect(calls[0]?.summary.endedAt).toBe(2_000)
  expect(calls[0]?.summary.partial).toBe(false)
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
  expect(calls[0]?.summary.chats).toBe(2)
  expect(calls[0]?.summary.startedAt).toBe(1_000)
})

test('SessionManager: collapses duplicate live-end bursts into one summary', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  manager.handle(100, ev('message', { uid: 1, username: 'a' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_001 })) // duplicate burst
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]?.summary.endedAt).toBe(2_001)
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
  expect(calls[0]?.summary.chats).toBe(2)
  expect(calls[0]?.summary.startedAt).toBe(1_000)
  expect(calls[0]?.summary.endedAt).toBe(3_000)
})

test('SessionManager: events without a live-start produce a partial summary', async () => {
  const { calls, manager } = makeManager()
  manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 5_000 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 6_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]?.summary.partial).toBe(true)
  expect(calls[0]?.summary.startedAt).toBe(5_000)
})

test('SessionManager: a real live-start after pre-live events adopts the true start', async () => {
  // A recordable event (pre-live chatter, or the first event after the service
  // restarted during stream prep) creates a partial session anchored at the
  // join time. The real live-start then arrives and must win — not be ignored
  // as a LIVE duplicate, which would pin the summary to the join time.
  const { calls, manager } = makeManager()
  manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 5_000 }))
  manager.handle(100, ev('live-start', { timestampNormalized: 5_100 }))
  manager.handle(100, ev('message', { uid: 2, username: 'b', timestampNormalized: 5_200 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 9_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]?.summary.partial).toBe(false) // the real start was observed
  expect(calls[0]?.summary.startedAt).toBe(5_100) // live-start time, not the 5_000 join
  expect(calls[0]?.summary.endedAt).toBe(9_000)
  expect(calls[0]?.summary.chats).toBe(1) // pre-live chatter dropped; only counts from the real start
})

test('SessionManager: the second live-start fire does not reset a just-promoted session', async () => {
  // Pre-live chatter opens a partial session; the real start's FIRST fire
  // promotes it; Bilibili's SECOND fire must be a no-op, not re-anchor to its
  // own (later) timestamp.
  const { calls, manager } = makeManager()
  manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 900 }))
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000, initial: true }))
  manager.handle(100, ev('live-start', { timestampNormalized: 1_002 })) // second fire
  manager.handle(100, ev('message', { uid: 2, username: 'b', timestampNormalized: 1_100 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]?.summary.partial).toBe(false)
  expect(calls[0]?.summary.startedAt).toBe(1_000) // first fire wins, not the 1_002 second fire
  expect(calls[0]?.summary.chats).toBe(1) // pre-live chatter dropped, post-start kept
})

test('SessionManager: a flap after a mid-stream join stays partial despite the double live-start fire', async () => {
  // Bot joined mid-stream (no live-start seen -> partial). The stream then
  // briefly flaps (end -> start) and Bilibili fires the restart's live-start
  // twice. The session must stay partial and keep its join time — the second
  // fire must not reset it to the flap time.
  const { calls, manager } = makeManager()
  manager.handle(100, ev('message', { uid: 1, username: 'a', timestampNormalized: 5_000 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 6_000 })) // flap: brief end
  manager.handle(100, ev('live-start', { timestampNormalized: 6_010 })) // flap restart, first fire (resume)
  manager.handle(100, ev('live-start', { timestampNormalized: 6_012 })) // second fire (must not reset)
  manager.handle(100, ev('message', { uid: 2, username: 'b', timestampNormalized: 6_100 }))
  manager.handle(100, ev('live-end', { timestampNormalized: 7_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]?.summary.partial).toBe(true) // still partial — true start never seen
  expect(calls[0]?.summary.startedAt).toBe(5_000) // join time, not the 6_012 flap restart
  expect(calls[0]?.summary.endedAt).toBe(7_000)
  expect(calls[0]?.summary.chats).toBe(2) // both messages kept (no reset)
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

test('SessionManager: handles the SDK firing live-start twice on a real start', async () => {
  // Bilibili always fires live-start twice at the start of a stream
  // (see @laplace.live/event-types live-start.ts: "开播事件必会触发两次").
  const { calls, manager } = makeManager()
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000, initial: true }))
  manager.handle(100, ev('live-start', { timestampNormalized: 1_002 })) // second fire, no initial
  manager.handle(100, ev('message', { uid: 1, username: 'a' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(1)
  expect(calls[0]?.summary.chats).toBe(1)
  expect(calls[0]?.summary.startedAt).toBe(1_000) // first fire wins, no reset
})

test('SessionManager: keeps sequential streams in the same room independent', async () => {
  const { calls, manager } = makeManager()

  // Stream A
  manager.handle(100, ev('live-start', { timestampNormalized: 1_000 }))
  manager.handle(100, ev('message', { uid: 1, username: 'a' }))
  manager.handle(100, ev('message', { uid: 2, username: 'b' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 2_000 }))
  await Bun.sleep(60)

  // Stream B in the same room, after A finalized
  manager.handle(100, ev('live-start', { timestampNormalized: 3_000 }))
  manager.handle(100, ev('message', { uid: 3, username: 'c' }))
  manager.handle(100, ev('live-end', { timestampNormalized: 4_000 }))
  await Bun.sleep(60)

  expect(calls.length).toBe(2)
  expect(calls[0]?.summary.chats).toBe(2)
  expect(calls[0]?.summary.startedAt).toBe(1_000)
  expect(calls[1]?.summary.chats).toBe(1) // not polluted by stream A
  expect(calls[1]?.summary.startedAt).toBe(3_000)
  expect(calls[1]?.summary.endedAt).toBe(4_000)
})
