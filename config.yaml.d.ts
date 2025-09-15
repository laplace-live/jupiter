import type { EventBridgeConfig, RoomConfig } from './types'

declare const config: {
  bridges: EventBridgeConfig[]
  rooms: RoomConfig[]
}

export = config
