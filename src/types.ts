export interface RoomConfig {
  room_id: number
  slug: string
  /** Streamer's UID */
  uid?: number
  show_slug?: boolean
  vip_users?: number[]
  telegram_announce_ch: number | string
  telegram_watchers_ch: number | string
  /** in coins (1000 coins = 1 CNY) */
  minimum_gift_price?: number
  /** in coins (1000 coins = 1 CNY) */
  minimum_guard_price?: number
  notify_room_enter?: boolean
  notify_watched_users_only?: boolean
}

export interface EventBridgeConfig {
  name: string
  url: string
  token?: string
}

export interface Config {
  bridges: EventBridgeConfig[]
  rooms: RoomConfig[]
}
