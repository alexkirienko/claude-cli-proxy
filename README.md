# Claude CLI Proxy

HTTP proxy server that wraps [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) to provide an Anthropic-compatible Messages API. Designed for use with [OpenClaw](https://github.com/nickarls/openclaw) but works with any client expecting the Anthropic API format.

## Why?

Claude CLI uses your Claude Max subscription ($200/month unlimited) instead of paying per-token API costs. This proxy lets you use Claude CLI as a backend for tools that expect the Anthropic HTTP API.

## Features

- Full Anthropic Messages API streaming compatibility
- Real-time `text_delta` events with `--include-partial-messages`
- Tool use, thinking, and processing state visibility
- Monitoring endpoint for dashboards (`/events` SSE stream)
- Handles large prompts via stdin (no E2BIG errors)

## Requirements

- Node.js 18+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude Max subscription (for unlimited usage)

## Installation

```bash
git clone https://github.com/alexkirienko/claude-cli-proxy.git
cd claude-cli-proxy
npm install  # no dependencies, but creates node_modules
```

## Usage

### Quick start

```bash
node server.js
# or
npm start
```

### With debug logging

```bash
DEBUG=1 node server.js
# or
npm run start:debug
```

### Custom port

```bash
node server.js --port 9000
# or
CLAUDE_PROXY_PORT=9000 node server.js
```

### Custom Claude path

```bash
CLAUDE_PATH=/path/to/claude node server.js
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API (streaming supported) |
| `/v1/models` | GET | List available models |
| `/health` | GET | Health check |
| `/events` | GET | SSE stream for monitoring |

## OpenClaw Configuration

Add to your `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "claude-proxy": {
        "baseUrl": "http://127.0.0.1:8787",
        "apiKey": "dummy",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "opus",
            "name": "Claude Opus 4.5 (Proxy)",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 16384
          },
          {
            "id": "sonnet",
            "name": "Claude Sonnet 4.5 (Proxy)",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 16384
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-proxy/opus"
      }
    }
  }
}
```

## Systemd Service (Linux)

Create `~/.config/systemd/user/claude-cli-proxy.service`:

```ini
[Unit]
Description=Claude CLI Proxy Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/claude-cli-proxy
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment="DEBUG=1"
Environment="CLAUDE_PROXY_PORT=8787"

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable claude-cli-proxy
systemctl --user start claude-cli-proxy
```

## Model Mapping

The proxy maps model names to Claude CLI flags:

| Request Model | CLI Flag |
|---------------|----------|
| `*opus*` | `--model opus` |
| `*sonnet*` | `--model sonnet` |
| `*haiku*` | `--model haiku` |

## Streaming

When `stream: true` is set in the request:
- Uses `--output-format stream-json --verbose --include-partial-messages`
- Emits `content_block_delta` events with `text_delta` as text is generated
- Compatible with Anthropic SDK streaming consumers

## Monitoring

Connect to `/events` for real-time SSE events:

```bash
curl -N http://localhost:8787/events
```

Events include:
- `request_start` / `request_complete`
- `cli_spawn` / `cli_init` / `cli_result`
- `thinking_start` / `thinking_end`
- `tool_use_start` / `tool_use_end`
- `text_start` / `text_end`

## License

MIT
