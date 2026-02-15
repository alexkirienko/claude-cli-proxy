# Claude CLI Proxy

HTTP proxy that wraps Claude CLI into an Anthropic-compatible Messages API. Allows tools like OpenClaw to use a Claude Max subscription instead of per-token API billing.

## Tech Stack

- **Runtime**: Node.js 18+
- **Dependencies**: Zero (only Node.js built-ins)
- **Main file**: `server.js`
- **Current version**: 0.4.0

## Run

```bash
npm start                # Default port 8787
npm run start:debug      # With debug logging (DEBUG=1)
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_PROXY_PORT` | `8787` | Server port |
| `CLAUDE_PATH` | `~/.local/bin/claude` | Path to Claude CLI |
| `DEBUG` | (unset) | `1` for verbose logging |

## Service (systemd)

```bash
systemctl --user start claude-cli-proxy
systemctl --user status claude-cli-proxy
systemctl --user restart claude-cli-proxy
```

Config: `~/.config/systemd/user/claude-cli-proxy.service`

## API Endpoints

- `POST /v1/messages` — Anthropic Messages API (streaming)
- `GET /v1/models` — Available models (opus, sonnet, haiku)
- `GET /health` — Health check
- `GET /events` — SSE monitoring stream

## CI/CD

- **GitHub Actions**: release-please on push to `main`
- **Repo**: https://github.com/alexkirienko/claude-cli-proxy

## Key Architecture Notes

- Spawns Claude CLI as child process per session
- Sessions persist via JSONL files, resume with `--resume`
- Queue-based request handling with priority preemption
- Listens on `127.0.0.1` only (loopback)
