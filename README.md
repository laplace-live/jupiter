# laplace-jupiter

A Telegram bot that connects to multiple LAPLACE Event Bridge WebSocket servers simultaneously and aggregates live stream chat events to forward to Telegram channels based on room configuration.

## Features

- 🔌 Connects to multiple LAPLACE Event Bridges simultaneously
- 📡 Aggregates events from all connected bridges
- 🎯 Room-based event filtering and routing
- 💬 Different channels for different event types (gifts vs other events)
- 🔄 Automatic reconnection support for each bridge
- 📋 YAML-based configuration
- 🔀 Fault tolerance - continues running even if some bridges fail

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- Telegram Bot Token from [@BotFather](https://t.me/botfather)
- Telegram API ID and Hash from [my.telegram.org](https://my.telegram.org)
- One or more LAPLACE Event Bridge WebSocket server URLs
- Telegram channel IDs for forwarding events

## Installation

To install dependencies:

```bash
bun install
```

## Configuration

1. Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

2. Fill in your Telegram bot credentials:

```env
# Telegram Bot Configuration
API_ID=your_telegram_api_id
API_HASH=your_telegram_api_hash
BOT_TOKEN=your_bot_token
```

3. Copy `config.yaml.example` to `config.yaml`:

```bash
cp config.yaml.example config.yaml
```

4. Update `config.yaml` with your settings:

```yaml
# LAPLACE Event Bridge connection settings
bridges:
  - name: primary
    url: wss://your-websocket-server.com
    token: optional_authentication_key

  - name: secondary
    url: wss://another-server.com
    token: another_token

# Room configurations
rooms:
  - room_id: 25034104
    slug: 明前奶绿
    vip_users:
      - 2132180406
      - 7706705
      - 14387072
      - 2763
    telegram_announce_ch: -1001704730870
    telegram_watchers_ch: -15123135
```

### Configuration Fields

#### Event Bridge Settings
- `name`: Unique identifier for the connection (used in logs)
- `url`: WebSocket URL for LAPLACE Event Bridge
- `token`: Optional authentication token

#### Room Settings
- `room_id`: The LAPLACE room ID to monitor (across all bridges)
- `slug`: Human-readable name for the room
- `vip_users`: List of VIP user IDs (for future use)
- `telegram_announce_ch`: Telegram channel ID for message events
- `telegram_watchers_ch`: Telegram channel ID for gift and superchat events

## Usage

To run the bot:

```bash
bun run index.ts
```

The bot will:
1. Load configuration from `config.yaml`
2. Connect to all configured LAPLACE Event Bridges
3. Aggregate events from all bridges
4. Filter incoming events by room ID
5. Route events to appropriate Telegram channels:
   - Gift events → `telegram_watchers_ch`
   - SuperChat events → `telegram_watchers_ch`
   - Message events → `telegram_announce_ch`
   - Other events → Ignored

## Multiple Event Bridges

The bot supports connecting to multiple event bridges simultaneously. This is useful for:
- **Load balancing**: Distribute the load across multiple servers
- **Redundancy**: Continue receiving events even if one bridge fails
- **Different sources**: Connect to bridges from different providers or regions

Each event bridge connection:
- Is managed independently
- Has its own reconnection logic
- Shows its status in logs with the bridge name prefix
- Continues to work even if other bridges fail

Example log output:
```
[primary] Connected to event bridge
[secondary] Connection state changed to: connecting
[primary] Event from room 明前奶绿 (25034104): message
[secondary] Event from room 明前奶绿 (25034104): gift
```

## Event Types Supported

The bot handles the following event types:
- **Message Events**: Chat messages from viewers → announce channel
- **Gift Events**: Gift notifications → watchers channel
- **SuperChat Events**: Paid messages with amount → watchers channel
- Other event types are logged but not forwarded

## Development

This project was created using `bun init` in bun v1.2.19. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
