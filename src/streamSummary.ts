import type { LaplaceEvent } from '@laplace.live/event-types'

import type { RoomConfig } from './types'

import { formatDuration } from './utils'

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

/**
 * Render a StreamSummary as a Telegram markdown message. Pure.
 *
 * `escapeText` is applied to every viewer-supplied field (usernames, the SC
 * message) so a hostile value cannot inject markdown or make the downstream
 * `md()` parser throw and suppress the whole summary. Defaults to identity for
 * tests that don't care about escaping; production passes `md.escape`.
 */
export function formatSummary(
  s: StreamSummary,
  room: RoomConfig,
  escapeText: (text: string) => string = text => text
): string {
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
  if (s.topGifter) highlights.push(`🏆 最佳金主 ${escapeText(s.topGifter.name)} ¥${fmtMoney(s.topGifter.total)}`)
  if (s.biggestSc) {
    highlights.push(
      `🔥 最高 SC ${escapeText(s.biggestSc.name)} ¥${fmtMoney(s.biggestSc.amount)}: ${escapeText(s.biggestSc.message)}`
    )
  }
  if (s.topChatter) highlights.push(`⚡ 最活跃 ${escapeText(s.topChatter.name)} ${fmtNum(s.topChatter.count)} 条`)
  if (highlights.length > 0) blocks.push(highlights.join('\n'))

  return blocks.join('\n\n')
}

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
        // (Bilibili fires live-start twice on a real start — the second is a no-op here.)
        return
      }
      case 'live-end': {
        if (!this.sessions.has(roomId)) return // IDLE -> nothing to end
        this.pendingEndAt.set(roomId, event.timestampNormalized)
        const existing = this.timers.get(roomId)
        if (existing) clearTimeout(existing)
        this.timers.set(
          roomId,
          setTimeout(() => this.finalizeRoom(roomId), this.debounceMs)
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
      console.error(`[summary] onSummary failed for room ${roomId}:`, err)
    )
  }
}
