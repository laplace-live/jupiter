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
  /** chats / uniqueChatters (0 when nobody chatted). */
  chatsPerCapita: number
  watchedMax: number
  onlinePeak: number
  /** Mean of all online-update samples (simple sample mean; 0 when none seen). */
  avgOnline: number
  likesMax: number
  newFollows: number
  gifts: { count: number; revenue: number }
  sc: { count: number; revenue: number }
  guards: { count: number; revenue: number }
  totalRevenue: number
  /** totalRevenue per hour of duration (0 when duration is 0). */
  hourlyRevenue: number
  /** Top spenders by total normalized spend (gold gifts + SC + guards), descending (≤ TOP_N). */
  topSpenders: Array<{ uid: number; name: string; total: number }>
  /** Most active chatters by danmaku count, descending (≤ TOP_N). */
  topChatters: Array<{ uid: number; name: string; count: number }>
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

/** Max entries shown in each leaderboard (金主榜 / 弹幕榜). */
const TOP_N = 10

/** In-memory accumulator for a single live session. Pure: no I/O. */
export class SessionStats {
  readonly startedAt: number
  readonly partial: boolean

  /**
   * True once a live-start has anchored this session — either it opened the
   * session (a real start) or it resumed the same session across a brief
   * end→start flap. A non-partial session is anchored at birth; a partial one
   * (opened by a stray recordable event) is not, until a real live-start
   * promotes it. Blocks Bilibili's repeated start fires (it fires live-start
   * twice on every start) from re-anchoring a session that is already running.
   */
  private liveStartBound: boolean

  private chats = 0
  private readonly chatters = new Map<number, { name: string; count: number }>()
  private watchedMax = 0
  private onlinePeak = 0
  private onlineSum = 0
  private onlineSamples = 0
  private likesMax = 0
  private newFollows = 0
  private giftCount = 0
  private giftRevenue = 0
  private scCount = 0
  private scRevenue = 0
  private guardCount = 0
  private guardRevenue = 0
  /** Per-viewer total normalized spend across all paid event types (金主榜 source). */
  private readonly spenders = new Map<number, { name: string; total: number }>()

  constructor(startedAt: number, partial: boolean) {
    this.startedAt = startedAt
    this.partial = partial
    // A non-partial session was opened by a live-start; a partial one was
    // opened by a stray recordable event and has not yet seen its start.
    this.liveStartBound = !partial
  }

  /** Whether a live-start has already anchored this session. */
  get hasLiveStart(): boolean {
    return this.liveStartBound
  }

  /** Record that a live-start has now anchored this session (promotion or flap-resume). */
  bindLiveStart(): void {
    this.liveStartBound = true
  }

  /** Attribute a paid event's normalized amount to a viewer's running spend total. */
  private addSpend(uid: number, name: string, amount: number): void {
    const s = this.spenders.get(uid)
    if (s) s.total += amount
    else this.spenders.set(uid, { name, total: amount })
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
        this.onlineSum += event.online
        this.onlineSamples++
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
          this.addSpend(event.uid, event.username, event.priceNormalized)
        }
        break
      case 'superchat':
        this.scCount++
        this.scRevenue += event.priceNormalized
        this.addSpend(event.uid, event.username, event.priceNormalized)
        break
      case 'toast':
        this.guardCount++
        this.guardRevenue += event.priceNormalized
        this.addSpend(event.uid, event.username, event.priceNormalized)
        break
      default:
        break
    }
  }

  finalize(endedAt: number): StreamSummary {
    const topChatters = [...this.chatters.entries()]
      .map(([uid, v]) => ({ uid, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N)

    const topSpenders = [...this.spenders.entries()]
      .map(([uid, v]) => ({ uid, name: v.name, total: v.total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_N)

    const durationMs = Math.max(0, endedAt - this.startedAt)
    const totalRevenue = this.giftRevenue + this.scRevenue + this.guardRevenue

    return {
      startedAt: this.startedAt,
      endedAt,
      durationMs,
      partial: this.partial,
      chats: this.chats,
      uniqueChatters: this.chatters.size,
      chatsPerCapita: this.chatters.size > 0 ? this.chats / this.chatters.size : 0,
      watchedMax: this.watchedMax,
      onlinePeak: this.onlinePeak,
      avgOnline: this.onlineSamples > 0 ? this.onlineSum / this.onlineSamples : 0,
      likesMax: this.likesMax,
      newFollows: this.newFollows,
      gifts: { count: this.giftCount, revenue: this.giftRevenue },
      sc: { count: this.scCount, revenue: this.scRevenue },
      guards: { count: this.guardCount, revenue: this.guardRevenue },
      totalRevenue,
      hourlyRevenue: durationMs > 0 ? totalRevenue / (durationMs / 3_600_000) : 0,
      topSpenders,
      topChatters,
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

  let header = `#${room.slug} #直播总结`
  if (s.partial) header = `⚠️ 部分数据（监控中途启动）\n${header}`
  blocks.push(header)

  blocks.push(`🕐 时长 ${formatDuration(s.durationMs)}  ·  ${clock(s.startedAt)} → ${clock(s.endedAt)}`)

  const money: string[] = []
  if (s.gifts.count > 0) money.push(`🎁 礼物 ${fmtNum(s.gifts.count)} - ¥${fmtMoney(s.gifts.revenue)}`)
  if (s.sc.count > 0) money.push(`💌 醒目留言 ${fmtNum(s.sc.count)} - ¥${fmtMoney(s.sc.revenue)}`)
  if (s.guards.count > 0) money.push(`⚓ 大航海 ${fmtNum(s.guards.count)} - ¥${fmtMoney(s.guards.revenue)}`)
  if (money.length > 0) {
    const lines = [`💰 总收入 ¥${fmtMoney(s.totalRevenue)}`, ...money]
    if (s.hourlyRevenue > 0) lines.push(`💵 时薪 ¥${fmtMoney(s.hourlyRevenue)}`)
    blocks.push(lines.join('\n'))
  }

  const audience: string[] = []
  if (s.watchedMax > 0) audience.push(`👥 看过 ${fmtNum(s.watchedMax)}`)
  if (s.onlinePeak > 0) audience.push(`🟢 峰值同接 ${fmtNum(s.onlinePeak)}`)
  if (s.avgOnline > 0) audience.push(`📊 平均同接 ${fmtNum(Math.round(s.avgOnline))}`)
  if (s.likesMax > 0) audience.push(`👍 点赞 ${fmtNum(s.likesMax)}`)
  if (s.newFollows > 0) audience.push(`➕ 新增关注 ${fmtNum(s.newFollows)}`)
  if (audience.length > 0) blocks.push(audience.join('\n'))

  const chat: string[] = [`💬 弹幕 ${fmtNum(s.chats)}`]
  if (s.uniqueChatters > 0) chat.push(`🗣️ 发言 ${fmtNum(s.uniqueChatters)} 人`)
  if (s.chatsPerCapita > 0) chat.push(`📈 人均弹幕 ${fmtMoney(s.chatsPerCapita)} 条`)
  blocks.push(chat.join('\n'))

  if (s.topSpenders.length > 0) {
    const lines = s.topSpenders.map((g, i) => `${i + 1}. ${escapeText(g.name)} ¥${fmtMoney(g.total)}`)
    blocks.push(['🏆 金主榜', ...lines].join('\n'))
  }
  if (s.topChatters.length > 0) {
    const lines = s.topChatters.map((c, i) => `${i + 1}. ${escapeText(c.name)} ${fmtNum(c.count)} 条`)
    blocks.push(['⚡ 弹幕榜', ...lines].join('\n'))
  }

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
          // ENDING -> resume: brief blip, keep counting the same session. The
          // restart's live-start anchors the session so its guaranteed second
          // fire (below) can't reset it.
          clearTimeout(timer)
          this.timers.delete(roomId)
          this.pendingEndAt.delete(roomId)
          this.sessions.get(roomId)?.bindLiveStart()
          return
        }
        const session = this.sessions.get(roomId)
        if (!session || !session.hasLiveStart) {
          // IDLE -> start a new session, OR a partial session that a recordable
          // event opened before this live-start (pre-live chatter, or the first
          // event after a restart during stream prep) is now superseded by the
          // real start. Anchor to the authoritative start time and drop the
          // pre-start noise, instead of leaving the summary pinned to the join.
          this.sessions.set(roomId, new SessionStats(event.timestampNormalized, false))
        }
        // else already anchored -> ignore (do not reset stats). Bilibili fires
        // live-start twice on a real start; the second fire is a no-op here.
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
