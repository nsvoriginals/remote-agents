# Remote Agent

**A Slack bot that gives every thread its own AI coding agent, running in a Docker sandbox.**

Mention the bot, describe a task, and [OpenCode](https://opencode.ai) writes files and runs commands inside a container, then reports back in the thread with live progress.

```
Slack  ──▶  Bot (Node.js)  ──▶  Docker container (OpenCode server)  ──▶  Agent works  ──▶  Slack
```

- **No public URL needed.** Slack Socket Mode connects outbound.
- **One warm container, many conversations.** Each Slack thread (or DM) maps to its own OpenCode session, so context stays separate and replies are instant.
- **Sandboxed.** All tool calls happen in the container. Only `./workspace` is shared with your host.
- **Self-healing.** Missing container, stopped container or lost session? The bot recreates it and carries on.

## Quick start

**Requirements:** Node.js 18+, Docker, a Slack workspace where you can install apps, and a model API key (Anthropic by default).

```bash
git clone https://github.com/nsvoriginals/remote-agents.git && cd remote-agents
npm install
cp .env.example .env     # fill in the values below
npm run start
```

On first run the bot pulls `sprisa/opencode:latest`, creates the `opencode-agent` container, waits for it to become healthy, then connects to Slack:

```
⚡ Slack bot running (bot user U0XXXXXXXX)
[health] OpenCode up after 6s
[docker] agent ready
```

Then in Slack:

```
@yourbot create an index.html in /workspace with a modern calculator (inline CSS and JS)
```

The result appears in `./workspace/` on your host.

## Slack app setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and choose **Create New App → From scratch**.
2. **Socket Mode:** enable it and create an app-level token with the `connections:write` scope. This is your `SLACK_APP_TOKEN` (`xapp-…`).
3. **OAuth & Permissions → Bot Token Scopes:**

   | Scope | Needed for |
   |---|---|
   | `app_mentions:read`, `chat:write` | Required |
   | `im:history`, `im:read`, `im:write` | Direct messages |
   | `channels:history`, `groups:history` | Follow-ups in channel threads without re-mentioning the bot |
   | `reactions:write` | Optional: 👀 / ✅ / ❌ status reactions |

4. **Event Subscriptions → Bot Events:** `app_mention`, `message.im`, plus `message.channels` and `message.groups` if you added the history scopes.
5. Install the app to your workspace and copy the **Bot User OAuth Token**. This is your `SLACK_BOT_TOKEN` (`xoxb-…`).
6. Invite the bot to a channel with `/invite @YourBot`.

> Added scopes after installing? Reinstall the app, because tokens are locked to the scopes they were issued with.

## Configuration

Set these in `.env`:

| Variable | Default | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | – | **Required.** `xoxb-…` |
| `SLACK_APP_TOKEN` | – | **Required.** `xapp-…` |
| `ANTHROPIC_API_KEY` | `public` | Set a real key, or the agent can't reach the model |
| `OPENCODE_CONTAINER_NAME` | `opencode-agent` | A plain Docker name (no `/` or `:`) |
| `OPENCODE_PORT` | `4096` | Host port for the container |
| `HOST_IP` | `127.0.0.1` | Use `host.docker.internal` only if the bot itself runs in Docker |
| `WORKSPACE_DIR` | `./workspace` | Mounted at `/workspace` in the container |
| `AUTO_APPROVE` | `true` | Auto-approve agent tool permissions (see [Security](#security)) |

Container settings (name, port, API key, mounts) are applied **when the container is created**. After changing any of them, run `docker rm -f opencode-agent` and restart the bot.

## Using the bot

| Where | Behavior |
|---|---|
| **Channel** | `@mention` the bot to start a thread. Replies in that thread continue the conversation, with no mention needed (requires the history scopes above). |
| **DM** | One continuous conversation per DM. |
| **Reset** | Send `reset`, `/reset` or `new session` to start fresh. |

While working, the bot posts a live-updating message with a status line such as `🔧 write: index.html · ⏱ 12s`. When it's done you get the formatted answer plus a footer like `✅ Done in 23s · 🔧 write, bash`. Failures show the actual error with a hint.

## How it works

- **Routing.** Bots and edits are ignored. Slack sends both `message` and `app_mention` for a mention, so events are de-duplicated by `channel:ts`. Work is queued per conversation so messages in one thread never race.
- **Sessions.** `sessions.json` maps each Slack thread to an OpenCode session ID (atomic writes). A missing session is recreated transparently.
- **Prompting.** The bot snapshots existing message IDs, calls `POST /session/:id/prompt_async`, then polls `GET /session/:id/message` every second. It only considers *new* assistant messages, surfaces model errors, and finishes when the reply is complete. Polling is used because OpenCode's SSE stream didn't deliver events reliably in testing.
- **Timeouts.** The bot gives up after 3 minutes with no progress, 90 seconds if the agent never starts replying, or 20 minutes in total.
- **Permissions.** With `AUTO_APPROVE=true`, pending tool permission requests for the active session are approved automatically, so the agent doesn't stall waiting for a human.

## Project structure

```
rem-agent/
├── index.js            # Entrypoint: starts Slack app, wires handlers
├── config.js           # Env vars, paths, timeouts
├── src/
│   ├── docker.js       # Container lifecycle (pull, boot, ensureReady)
│   ├── opencode.js     # HTTP client, sessions, prompt + poll, permissions
│   ├── sessions.js     # sessions.json load/save
│   ├── slack-format.js # Message blocks, chunking, mrkdwn conversion
│   ├── slack-client.js # Post/update/react helpers with block fallback
│   └── handler.js      # Routing, dedupe, per-thread queue
├── workspace/          # Mounted into the container
└── sessions.json       # Thread → session map (gitignored)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot connects but never responds | Invite it to the channel. Check scopes and event subscriptions, then reinstall the app. |
| `missing_scope` | Add the scope under OAuth & Permissions and reinstall. |
| "Agent never started replying" | Usually a bad `ANTHROPIC_API_KEY`. Fix `.env`, then `docker rm -f opencode-agent`. |
| Stuck on 💭 Thinking | `docker logs opencode-agent --tail 50` |
| Port 4096 in use | `docker ps` and remove the other container, or change `OPENCODE_PORT`. |
| Health check times out | Check container logs. On Windows, confirm `HOST_IP=127.0.0.1`. |
| File not on host | `docker inspect opencode-agent --format "{{json .Mounts}}"` and check the bind source path. |

Handy commands:

```bash
docker logs opencode-agent --tail 50             # server output
docker exec -it opencode-agent bash              # shell inside the sandbox
docker exec opencode-agent ls -la /workspace     # what the agent created
docker rm -f opencode-agent                      # reset the container
```

## Security

Built for **personal use**. All threads share one container and workspace, and `AUTO_APPROVE` lets the agent run commands without asking. Before opening it up to a team:

- Never put secrets in prompts. Treat anything the agent reads (READMEs, web pages, files) as untrusted input.
- Restrict who can message the bot in your Slack app settings.
- Set `AUTO_APPROVE=false` if you're running untrusted prompts.
- Add container limits (`Memory`, `NanoCpus`, `PidsLimit`), run as non-root, and restrict network egress.

## Roadmap

- [ ] Per-thread or per-user containers with dynamic ports
- [ ] Reap idle containers and stale sessions
- [ ] Slash commands (`/agent status`, `/agent stop`)
- [ ] File uploads from Slack into `/workspace`
- [ ] Live streaming once OpenCode's SSE is reliable
- [ ] Other model providers (OpenAI, Google, Ollama)

## Credits

[OpenCode](https://opencode.ai) · [Slack Bolt](https://slack.dev/bolt-js) · [dockerode](https://github.com/apocas/dockerode) · [sprisa/opencode](https://hub.docker.com/r/sprisa/opencode)

## License

MIT