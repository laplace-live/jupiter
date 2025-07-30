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
TELEGRAM_API_ID=your_telegram_api_id
TELEGRAM_API_HASH=your_telegram_api_hash
TELEGRAM_BOT_TOKEN=your_bot_token
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

  # Example of bridge-specific room configuration
  - room_id: 12345678
    slug: 测试房间
    telegram_announce_ch: -1001704730870
    telegram_watchers_ch: -15123135
    bridge: primary # Only monitor this room on 'primary' bridge
```

### Configuration Fields

#### Event Bridge Settings

- `name`: Unique identifier for the connection (used in logs)
- `url`: WebSocket URL for LAPLACE Event Bridge
- `token`: Optional authentication token

#### Room Settings

- `room_id`: The LAPLACE room ID to monitor
- `slug`: Human-readable name for the room
- `vip_users`: List of VIP user IDs (for future use)
- `telegram_announce_ch`: Telegram channel ID for message events
- `telegram_watchers_ch`: Telegram channel ID for gift and superchat events
- `bridge` (optional): Specific bridge name to monitor this room. If not specified, all bridges will monitor it (may result in duplicate events)

## Usage

### Local Development

To run the bot locally:

```bash
bun run index.ts
```

For hot reload during development:

```bash
bun run dev
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

## Configuration Loading

The bot loads configuration from multiple sources:

### Environment Variables

Required environment variables (loaded from `.env` file or system environment):

- `TELEGRAM_API_ID`: Your Telegram API ID from [my.telegram.org](https://my.telegram.org)
- `TELEGRAM_API_HASH`: Your Telegram API Hash from [my.telegram.org](https://my.telegram.org)
- `TELEGRAM_BOT_TOKEN`: Your bot token from [@BotFather](https://t.me/botfather)

### Configuration File

The bot expects a `config.yaml` file in the working directory. This file contains:

1. **Event Bridge Connections**: WebSocket URLs and authentication tokens
2. **Room Configurations**: Room IDs, channel mappings, and filtering rules

The configuration is loaded at startup using:

```typescript
const configFile = await Bun.file('config.yaml').text()
const config: Config = YAML.parse(configFile)
```

### Configuration Hot Reload

Currently, the bot requires a restart to load configuration changes. The configuration file is read once at startup.

### Docker Configuration

When running in Docker:

1. **Mount the config file**: The `config.yaml` must be mounted into the container at `/app/config.yaml`
2. **Pass environment variables**: Use `-e` flags or Docker Compose environment section
3. **Persist session data**: Mount a volume at `/app/bot-data` to persist Telegram session

Example with all options:

```bash
docker run -d \
  --name laplace-jupiter \
  --restart unless-stopped \
  -v /path/to/your/config.yaml:/app/config.yaml:ro \
  -v /path/to/bot-data:/app/bot-data \
  -e TELEGRAM_API_ID=12345678 \
  -e TELEGRAM_API_HASH=abcdef1234567890 \
  -e TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11 \
  ghcr.io/laplace-live/jupiter:latest
```

## How It Works

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
