# LAPLACE Jupiter

High performance bilibili live events forwarder/monitor for social chats

A bot that connects to multiple LAPLACE Event Bridge WebSocket servers simultaneously and aggregates live stream chat events to forward to social chats based on room configuration.

This is the successor of [eop-blive](https://subspace.institute/docs/eye-of-providence/eop_blive) project.

## Features

- 🔌 Connects to multiple LAPLACE Event Bridges simultaneously
- 📡 Aggregates events from all connected bridges
- 🎯 Room-based event filtering and routing
- 💬 Different channels for different event types (gifts vs other events)
- 🔄 Automatic reconnection support for each bridge
- 📋 YAML-based configuration
- 🔀 Fault tolerance - continues running even if some bridges fail

## How It Works

The bot will:

1. Load configuration from `config.yaml`
2. Connect to all configured LAPLACE Event Bridges
3. Aggregate events from all bridges
4. Filter incoming events by room ID
5. Route events to appropriate social chats

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

1. Copy `config.example.yaml` to `config.yaml`:

```bash
cp config.example.yaml config.yaml
```

2. Create a `.env` file with your Telegram bot credentials:

```env
# Telegram Bot Configuration
TELEGRAM_API_ID=your_telegram_api_id
TELEGRAM_API_HASH=your_telegram_api_hash
TELEGRAM_BOT_TOKEN=your_bot_token
```

3. Update `config.yaml` with your settings:

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
    uid: 2132180406 # Streamer's UID
    slug: 明前奶绿
    vip_users: []
    telegram_announce_ch: -12345
    telegram_watchers_ch: -12345
    # Optional: Minimum gift price to notify (in coins, 1000 = 1 CNY, default: 100000)
    minimum_gift_price: 100000
    # Optional: Minimum guard price to notify (in coins, 1000 = 1 CNY, default: 200000)
    minimum_guard_price: 200000
    # Optional: Whether to notify room enter events (default: false)
    notify_room_enter: false
    # Optional: Only notify when VIP users enter (default: false)
    notify_watched_users_only: false
    # Optional: Specific bridge name to monitor this room (if not specified, all bridges will monitor)
    bridge: primary
```

### Configuration Fields

#### Event Bridge Settings

- `name`: Unique identifier for the connection (used in logs)
- `url`: WebSocket URL for LAPLACE Event Bridge
- `token`: Optional authentication token

#### Room Settings

- `room_id`: The LAPLACE room ID to monitor
- `slug`: Human-readable name for the room
- `uid` (optional): Streamer's UID (helps identify streamer messages)
- `show_slug` (optional): Whether to show room slug in messages (default: true)
- `vip_users`: List of VIP user IDs (messages from these users are forwarded)
- `telegram_announce_ch`: Telegram channel ID for message events
- `telegram_watchers_ch`: Telegram channel ID for gift and monetary events
- `minimum_gift_price` (optional): Minimum gift value to notify in coins (1000 = 1 CNY, default: 100000)
- `minimum_guard_price` (optional): Minimum guard purchase value to notify in coins (default: 200000)
- `notify_room_enter` (optional): Whether to notify room enter events (default: false)
- `notify_watched_users_only` (optional): Only notify when VIP users enter (default: false)
- `bridge` (optional): Specific bridge name to monitor this room. If not specified, all bridges will monitor it (may result in duplicate events)

### Configuration Loading Details

The bot loads configuration from multiple sources:

#### Environment Variables

Required environment variables (loaded from `.env` file or system environment):

- `TELEGRAM_API_ID`: Your Telegram API ID from [my.telegram.org](https://my.telegram.org)
- `TELEGRAM_API_HASH`: Your Telegram API Hash from [my.telegram.org](https://my.telegram.org)
- `TELEGRAM_BOT_TOKEN`: Your bot token from [@BotFather](https://t.me/botfather)

#### Configuration File

The bot expects a `config.yaml` file in the working directory. This file contains:

1. **Event Bridge Connections**: WebSocket URLs and authentication tokens
2. **Room Configurations**: Room IDs, channel mappings, and filtering rules

The configuration is loaded at startup and currently requires a restart to reload changes.

## Usage

### Local Development

To run the bot locally:

```bash
bun run src/index.ts
```

For hot reload during development:

```bash
bun run dev
```

Or using the start script:

```bash
bun run start
```

### Docker Deployment

The bot can be deployed using Docker for production environments.

#### Build the Docker Image

```bash
# Build for local use
docker buildx bake build-local

# Or build using docker directly
docker build -t ghcr.io/laplace-live/jupiter:local .
```

#### Run with Docker

```bash
# Run with mounted config file and environment variables
docker run -d \
  --name laplace-jupiter \
  -v $(pwd)/config.yaml:/app/config.yaml:ro \
  -v $(pwd)/bot-data:/app/bot-data \
  -e TELEGRAM_API_ID=your_telegram_api_id \
  -e TELEGRAM_API_HASH=your_telegram_api_hash \
  -e TELEGRAM_BOT_TOKEN=your_bot_token \
  ghcr.io/laplace-live/jupiter:local
```

#### Using Docker Compose

Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  jupiter:
    image: ghcr.io/laplace-live/jupiter:latest
    container_name: laplace-jupiter
    restart: unless-stopped
    environment:
      - TELEGRAM_API_ID=${TELEGRAM_API_ID}
      - TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
    volumes:
      - ./config.yaml:/app/config.yaml:ro
      - ./bot-data:/app/bot-data
```

Then run:

```bash
# Create .env file with your credentials
echo "TELEGRAM_API_ID=your_telegram_api_id" > .env
echo "TELEGRAM_API_HASH=your_telegram_api_hash" >> .env
echo "TELEGRAM_BOT_TOKEN=your_bot_token" >> .env

# Start the container
docker-compose up -d
```

## Development

This project uses [Bun](https://bun.com) as its JavaScript runtime and is built with TypeScript. It leverages the [@laplace.live/event-bridge-sdk](https://www.npmjs.com/package/@laplace.live/event-bridge-sdk) for WebSocket connections and [@mtcute/bun](https://www.npmjs.com/package/@mtcute/bun) for Telegram integration.

## License

AGPL-3.0
