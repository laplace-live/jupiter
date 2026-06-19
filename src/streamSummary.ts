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
