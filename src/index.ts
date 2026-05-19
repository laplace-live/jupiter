import { LaplaceEventBridgeClient } from '@laplace.live/event-bridge-sdk'
import type { LaplaceEvent } from '@laplace.live/event-types'
import { TelegramClient } from '@mtcute/bun'
import type { CommonSendParams } from '@mtcute/bun/methods.js'
import { md } from '@mtcute/markdown-parser'

import type { EventBridgeConfig, RoomConfig } from './types'

import config from '../config.yaml'
import { EMOJI_MAP, GUARD_TYPE_DICT, PRICE_TIER_EMOJI, SUPERCHAT_TIER_EMOJI } from './consts'
import { EventStore, formatMessagesContext } from './eventStore'
import { timeFromNow } from './utils'

// Load configuration
// Create room map and event stores for each room
const roomMap = new Map<number, RoomConfig>()
const eventStores = new Map<number, EventStore>()
config.rooms.forEach(room => {
  roomMap.set(room.room_id, room)
  eventStores.set(room.room_id, new EventStore(6000))
})

console.log(`Loaded configuration for ${config.rooms.length} rooms and ${config.bridges.length} event bridges`)

// Ensure bot-data directory exists
const botDataDir = 'bot-data'
const { stat, mkdir } = await import('node:fs/promises')

try {
  const stats = await stat(botDataDir)
  if (stats.isDirectory()) {
    console.log(`${botDataDir} directory already exists`)
  }
} catch {
  // Directory doesn't exist, create it
  await mkdir(botDataDir, { recursive: true })
  console.log(`Created ${botDataDir} directory`)
}

if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
  throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required')
}

const tg = new TelegramClient({
  apiId: Number(process.env.TELEGRAM_API_ID),
  apiHash: process.env.TELEGRAM_API_HASH,
  storage: `${botDataDir}/session`,
})

// Create event bridge clients
const clients: { name: string; client: LaplaceEventBridgeClient }[] = []

interface SenderOptions {
  bridgeName: string
  event: LaplaceEvent
  telegramChannel: string | number
  telegramOptions?: CommonSendParams & {
    disableWebPreview?: boolean
  }
}

async function sender(message: string, options: SenderOptions) {
  const { bridgeName, event, telegramChannel, telegramOptions } = options
  await tg.sendText(telegramChannel, md(message), telegramOptions)
  console.log(`[${bridgeName}] Forwarded ${event.type} from ${event.origin} to channel`)
}

// Common event handler for all event bridges
const handleEvent = async (event: LaplaceEvent, bridge: EventBridgeConfig) => {
  const bridgeName = bridge.name

  // Check if event has room_id and if it's in our config
  const roomId = event.origin
  if (!roomId) {
    console.log(`[${bridgeName}] Event without room_id, discarding:`, event.type)
    return
  }

  const roomCfg = roomMap.get(roomId)
  if (!roomCfg) {
    console.log(`[${bridgeName}] Room ${roomId} not in config, discarding event:`, event.type)
    return
  }

  // Check if this room is configured for a specific bridge
  if (roomCfg.bridge && roomCfg.bridge !== bridgeName) {
    console.log(`[${bridgeName}] Room ${roomId} is configured for bridge '${roomCfg.bridge}', skipping`)
    return
  }

  // Store only message events in room-specific EventStore (for context feature)
  if (event.type === 'message') {
    const eventStore = eventStores.get(roomId)
    if (eventStore) {
      eventStore.addEvent(event)
    }
  }

  console.log(`[${bridgeName}] Event from room ${roomCfg.slug} (${roomId}):`, event.type)

  try {
    // channel config
    const announceTelegramCh = roomCfg.telegram_announce_ch
    const watchersTelegramCh = roomCfg.telegram_watchers_ch
    const slug = roomCfg.show_slug ? `#${roomCfg.slug} ` : ''
    const footer = `[${timeFromNow(event.timestampNormalized)}](https://live.bilibili.com/${event.origin}) | #uid${event.uid} | [laplace](https://laplace.live/user/${event.uid}) | [danmakus](https://danmakus.com/user/${event.uid}) | [aicu](https://aicu.cc/reply.html?uid=${event.uid})`

    const senderOpts = {
      bridgeName,
      event,
      telegramChannel: announceTelegramCh,
      telegramOptions: {
        disableWebPreview: true,
      },
    } satisfies SenderOptions

    // Route events based on type
    if (event.type === 'interaction') {
      const interactType = event.action === 1 ? '进入' : '关注'
      const message = `${slug}@[${event.username}](https://space.bilibili.com/${event.uid}) #${interactType}直播间\n\n${footer}`

      // Check if room has notify_room_enter enabled
      if (roomCfg.notify_room_enter) {
        if (roomCfg.notify_watched_users_only) {
          if (roomCfg.vip_users?.includes(event.uid)) {
            await sender(message, senderOpts)
          }
        } else {
          await sender(message, senderOpts)
        }
      }
    }

    if (event.type === 'message') {
      const modeBadge = event.userType === 1 ? '🔧' : ''
      const isStreamer = event.userType === 100 || (roomCfg.uid && event.uid === roomCfg.uid)
      const isVipUser = roomCfg.vip_users?.includes(event.uid)

      if (isStreamer || isVipUser) {
        let messageText = `${slug}@[${event.username}](https://space.bilibili.com/${event.uid})${modeBadge} #文本弹幕: ${event.message}`

        // Add context for UP or VIP users
        const recentEvents = eventStores.get(roomId)?.getRecentEvents(20) || []
        const recentContext = formatMessagesContext(recentEvents)

        if (recentContext) {
          messageText += `\n\n上下文：\n${recentContext}`
        }

        messageText += `\n\n${footer}`
        await sender(messageText, senderOpts)
      }
    }

    if (event.type === 'superchat') {
      const price = event.priceNormalized
      const tier = SUPERCHAT_TIER_EMOJI(price)
      const message = `${slug}@[${event.username}](https://space.bilibili.com/${event.uid}) #醒目留言${tier} ¥${price}: ${event.message}\n\n${footer}`
      senderOpts.telegramChannel = watchersTelegramCh
      await sender(message, senderOpts)
    }

    if (event.type === 'gift') {
      const price = event.priceNormalized
      const tier = PRICE_TIER_EMOJI(price)
      const emoji = EMOJI_MAP[event.giftName] || ''
      const message = `${slug}@[${event.username}](https://space.bilibili.com/${event.uid}) #赠送礼物${tier} #${event.giftName}${emoji}×${event.giftAmount} ¥${event.priceNormalized}\n\n${footer}`

      // Only send notifications for gifts expensive than threshold (default 100 CNY)
      const minimumGiftPrice = roomCfg.minimum_gift_price || 100 * 1000
      if (price * 1000 >= minimumGiftPrice && event.coinType === 'gold') {
        senderOpts.telegramChannel = watchersTelegramCh
        await sender(message, senderOpts)
      }
    }

    if (event.type === 'red-envelope-start') {
      const price = event.priceNormalized
      const message = `${slug}@[${event.username}](https://space.bilibili.com/${event.uid}) #发送红包🧧 ¥${event.priceNormalized}\n\n${footer}`
      const minimumGiftPrice = roomCfg.minimum_gift_price || 100 * 1000
      if (price * 1000 >= minimumGiftPrice) {
        senderOpts.telegramChannel = watchersTelegramCh
        await sender(message, senderOpts)
      }
    }

    if (event.type === 'lottery-start') {
      const message = `${slug} #天选抽奖🎟️ ${event.message}\n\n要求: ${event.requirement}\n奖励: ${event.rewardName}\n\n${footer}`
      await sender(message, senderOpts)
    }

    if (event.type === 'lottery-result') {
      const list = event.list.map(item => `[${item.uname}](https://laplace.live/user/${item.uid})`).join('\n')
      const message = `${slug} #天选抽奖结果🎟️ ${event.message} ${event.rewardName}\n\n${list}\n\n${footer}`
      await sender(message, senderOpts)
    }

    if (event.type === 'toast') {
      // Guard buy event
      const guardEmoji = GUARD_TYPE_DICT[event.toastType] || ''
      const price = event.priceNormalized
      const message = `${slug}@[${event.username}](https://space.bilibili.com/${event.uid}) #消费${event.toastName}${guardEmoji}×${event.toastAmount}: ¥${price}\n\n${footer}`

      // Only send notifications for guard expensive than threshold (default 200 CNY)
      const minimumGuardPrice = roomCfg.minimum_guard_price || 200 * 1000
      if (price * 1000 >= minimumGuardPrice) {
        senderOpts.telegramChannel = watchersTelegramCh
        await sender(message, senderOpts)
      }
    }

    if (event.type === 'mvp') {
      const price = event.priceNormalized
      const message = `${slug}@[${event.username}](https://space.bilibili.com/${event.uid}) #${event.action}${event.message}×${event.mvpAmount}: ¥${price}\n\n${footer}`

      // Only send notifications for mvp expensive than threshold (default 200 CNY)
      const minimumGuardPrice = roomCfg.minimum_guard_price || 200 * 1000
      if (price * 1000 >= minimumGuardPrice) {
        senderOpts.telegramChannel = watchersTelegramCh
        await sender(message, senderOpts)
      }
    }

    if (event.type === 'room-name-update') {
      const message = `${slug}#直播间标题更新 ${event.message}\n分区：${event.parentArea} - ${event.area}`
      await sender(message, senderOpts)
    }

    if (event.type === 'live-warning') {
      const recentEvents = eventStores.get(roomId)?.getRecentEvents(20) || []
      const recentContext = formatMessagesContext(recentEvents)
      let messageText = `${slug}#直播间被警告⚠️ ${event.message}`

      if (recentContext) {
        messageText += `\n\n上下文：\n${recentContext}`
      }

      messageText += `\n\n[前往直播间围观](https://live.bilibili.com/${event.origin})`
      await sender(`${messageText}`, senderOpts)
    }

    if (event.type === 'live-cutoff') {
      const recentEvents = eventStores.get(roomId)?.getRecentEvents(20) || []
      const recentContext = formatMessagesContext(recentEvents)
      let messageText = `${slug}#直播间被切断❌ ${event.message}`

      if (recentContext) {
        messageText += `\n\n上下文：\n${recentContext}`
      }

      messageText += `\n\n[前往直播间围观](https://live.bilibili.com/${event.origin})`
      await sender(messageText, senderOpts)
    }

    if (event.type === 'room-mute-on') {
      const message = `${slug}#开启直播间禁言🤐 ${event.message}`
      await sender(message, senderOpts)
    }

    if (event.type === 'room-mute-off') {
      const message = `${slug}#关闭直播间禁言🤗`
      await sender(message, senderOpts)
    }

    if (event.type === 'user-block') {
      const blockTypeDict = {
        1: '房管',
        2: '主播',
      }
      const blockType = blockTypeDict[event.operator] || '未知'

      // Get user's recent messages for context
      const userEvents = eventStores.get(roomId)?.getEventsByUid(event.uid, 10) || []
      const userContext = formatMessagesContext(userEvents)
      let messageText = `${slug}@[${event.username}](https://space.bilibili.com/${event.uid}) #被直播间禁言🍾️ 由${blockType}操作，有效期${event.vaildPeriod || '未知'}`

      if (userContext) {
        messageText += `\n\n魅力时刻/遗言：\n${userContext}`
      }

      messageText += `\n\n${footer}`
      await sender(`${messageText}`, senderOpts)
    }

    if (event.type === 'live-start') {
      if (event.initial) {
        const message = `${slug}#b站开播 🥳\n\n[${timeFromNow(event.timestampNormalized)}](https://live.bilibili.com/${event.origin}) | [LAPLACE Chat](https://chat.laplace.live/dashboard/${event.origin})`
        await sender(message, senderOpts)
      }
    }

    if (event.type === 'live-end') {
      const message = `${slug}#b站下播 😢\n\n[${timeFromNow(event.timestampNormalized)}](https://live.bilibili.com/${event.origin})`
      await sender(message, senderOpts)
    }

    if (event.type === 'mod-assign') {
      const message = `${slug}#任命房管 [UID:${event.mod}](https://laplace.live/user/${event.mod})`
      await sender(message, senderOpts)
    }

    if (event.type === 'mod-revoke') {
      const message = `${slug}#撤销房管 [UID:${event.mod}](https://laplace.live/user/${event.mod})`
      await sender(message, senderOpts)
    }

    if (event.type === 'mod-list') {
      const list = event.mods.map(mod => `[UID:${mod}](https://laplace.live/user/${mod})`).join('\n')
      const message = `${slug}#房管列表\n\n${list}`
      await sender(message, senderOpts)
    }
  } catch (error) {
    console.error(`[${bridgeName}] Error forwarding event from room ${roomCfg.slug}:`, error)
  }
}

// Initialize all event bridge connections
for (const bridge of config.bridges) {
  const client = new LaplaceEventBridgeClient({
    url: bridge.url,
    token: bridge.token,
  })

  // Handle connection state changes
  client.onConnectionStateChange(state => {
    console.log(`[${bridge.name}] Connection state changed to: ${state}`)
  })

  // Handle all incoming events from this bridge
  client.onAny(async event => {
    await handleEvent(event, bridge)
  })

  clients.push({ name: bridge.name, client })
}

// Start the services
async function start() {
  try {
    // Start Telegram bot first
    const user = await tg.start({ botToken: process.env.TELEGRAM_BOT_TOKEN })
    console.log('Logged in as', user.username)

    // Connect to all LAPLACE Event Bridges
    console.log('Connecting to event bridges...')
    const promises = clients.map(async ({ name, client }) => {
      try {
        await client.connect()
        console.log(`Connected to event bridge: ${name}`)
      } catch (error) {
        console.error(`Failed to connect to event bridge ${name}:`, error)
      }
    })

    await Promise.allSettled(promises)

    console.log('Connected event bridges:', clients.map(bridge => bridge.name).join(', '))

    // Show room monitoring configuration
    console.log('Room monitoring config:')
    Array.from(roomMap.values()).forEach(room => {
      const bridgeInfo = room.bridge ? `bridge '${room.bridge}'` : 'all bridges'
      console.log(`  - ${room.slug} (${room.room_id}): ${bridgeInfo}`)
    })
  } catch (error) {
    console.error('Failed to start services:', error)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...')

  // Disconnect all event bridges
  for (const { name, client } of clients) {
    console.log(`Disconnecting from ${name}...`)
    client.disconnect()
  }

  await tg.disconnect()
  process.exit(0)
})

// Start the bot
start()
