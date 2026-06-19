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
