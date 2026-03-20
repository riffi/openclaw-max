# openclaw-max

External OpenClaw channel plugin for VK MAX messenger.

Current state:
- includes inbound `message_created -> OpenClaw reply dispatch -> MAX text reply`
- includes native slash-command routing through the Gateway command path
- includes direct/group `allowFrom`
- includes optional mention-only behavior for groups
- does not yet implement media send or typing/status actions

## Goal

This plugin is intended to become a proper `MAX` channel adapter for OpenClaw so that:
- inbound MAX messages go through the Gateway channel pipeline
- registered slash commands are resolved by Gateway, like Telegram native commands
- directives such as `/model` are applied before model execution
- outbound replies, media, typing indicators, and `mark_seen` are sent through MAX Bot API

## Requirements

- OpenClaw `>= 2026.3.13`
- a created MAX bot with a valid bot token
- a public HTTPS webhook URL reachable by MAX
- if you want group messages, the bot must be an admin in that MAX group

## Install

### 1. Clone the plugin repo

Example:

```bash
cd /opt
git clone https://github.com/<you>/openclaw-max.git
```

This guide will assume the plugin lives at `/opt/openclaw-max`.

### 2. Mount the plugin into the OpenClaw gateway container

Your `docker-compose.yml` needs a read-only mount so OpenClaw can load the external plugin:

```yaml
services:
  openclaw-gateway:
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
      - /opt/openclaw-max:/plugins/openclaw-max:ro
```

If you publish MAX through Traefik from the same gateway container, add the extra network and labels too:

```yaml
services:
  openclaw-gateway:
    networks:
      - default
      - web
    labels:
      traefik.enable: "true"
      traefik.docker.network: web
      traefik.http.routers.max-plugin.entrypoints: websecure
      traefik.http.routers.max-plugin.rule: Host(`max.example.com`)
      traefik.http.routers.max-plugin.tls.certresolver: letsencrypt
      traefik.http.services.max-plugin.loadbalancer.server.port: "8788"

networks:
  web:
    external: true
```

### 3. Enable the plugin in `openclaw.json`

Point OpenClaw at this repo with `plugins.load.paths`:

```json5
{
  plugins: {
    load: {
      paths: ["C:/path/to/openclaw-max"]
    },
    allow: ["max"],
    entries: {
      max: { enabled: true }
    }
  }
}
```

Use the container path, not the host path:

```json5
{
  plugins: {
    load: {
      paths: ["/plugins/openclaw-max"]
    },
    allow: ["max"],
    entries: {
      max: { enabled: true }
    }
  }
}
```

### 4. Configure the MAX channel

Minimal example:

```json5
{
  channels: {
    max: {
      enabled: true,
      botToken: "MAX_BOT_TOKEN",
      webhookUrl: "https://max.example.com/webhook",
      webhookSecret: "CHANGE_ME",
      webhookPath: "/webhook",
      webhookHost: "0.0.0.0",
      webhookPort: 8788,
      allowFrom: [7678432],
      groupRequireMention: true
    }
  }
}
```

Available config fields:

- `botToken`: MAX bot token
- `tokenFile`: path to a file containing the token
- `webhookUrl`: public HTTPS webhook URL registered in MAX
- `webhookSecret`: shared secret for webhook validation
- `webhookPath`: local listener path, usually `/webhook`
- `webhookHost`: bind host, usually `0.0.0.0`
- `webhookPort`: local listener port, default `8788`
- `apiBaseUrl`: defaults to `https://platform-api.max.ru`
- `allowFrom`: allowed direct users and groups
- `groupRequireMention`: if `true`, normal group text requires bot mention

### 5. Restart OpenClaw

Example:

```bash
cd /path/to/openclaw
docker compose restart openclaw-gateway
```

On startup the plugin should:

- authenticate the bot with MAX
- register the webhook
- start the local webhook listener on `8788`

### 6. Verify

Check logs:

```bash
docker logs --since 1m <gateway-container-name>
```

Expected lines are similar to:

```text
[max] [default] MAX bot authenticated as <bot_username>
[max] [default] MAX webhook registered
[max] [default] MAX webhook listener started on http://0.0.0.0:8788/webhook
```

Then test in MAX:

- direct chat: send `hello`
- direct chat: send `/status`
- group chat: send `@your_bot hello`
- group chat: send `/status`

If `groupRequireMention` is `true`, plain group text without mention is ignored, but standalone slash commands still work for allowed senders.

## Access control

Use `channels.max.allowFrom` to define who may talk to the bot:

- direct chat: allow the MAX user id, for example `7678432`
- group chat: allow the group/chat id as `group:<chatId>`, for example `group:242610078`

Example:

```json5
{
  channels: {
    max: {
      enabled: true,
      allowFrom: [7678432, "group:-72288998013664"]
    }
  }
}
```

Behavior:

- in direct chats, only explicitly allowed user ids are accepted
- in groups, if the group id is allowed, any participant in that group may talk to the bot
- entries prefixed as `max:...` also work, for example `max:group:242610078`

## Group behavior

Recommended setup:

- direct chat: allow only your own MAX user id
- group chat: allow the specific group id
- set `groupRequireMention: true` if you want normal group text to require `@bot`

Example:

```json5
{
  channels: {
    max: {
      enabled: true,
      allowFrom: [7678432, "group:-72288998013664"],
      groupRequireMention: true
    }
  }
}
```

Behavior:

- DM from allowed user: accepted
- DM from anyone else: ignored
- allowed group text without mention: ignored
- allowed group text with mention: accepted
- allowed group slash commands like `/status`: accepted without mention

## Commands

This plugin routes standalone slash commands through the OpenClaw Gateway command path instead of sending them to the model as plain text.

That means built-in and registered slash commands should behave like other native-capable channels:

- `/status`
- `/model`
- `/model gemini`
- user-defined registered slash commands

Important:

- commands should be sent as a standalone message starting with `/`
- in groups, command-only messages bypass mention gating for allowed senders
- normal group text still follows `groupRequireMention`

## Planned implementation slices

1. Outbound media send, `typing_on`, `mark_seen`
2. Better MAX event modeling for replies/callbacks/groups
3. Status, setup, and docs polish

## Files

- `index.ts`: plugin entrypoint
- `setup-entry.ts`: setup-only entrypoint
- `openclaw.plugin.json`: manifest for discovery and config validation
- `src/channel.ts`: minimal channel plugin scaffold
- `src/accounts.ts`: account and token resolution
- `src/api.ts`: MAX Bot API client helpers
- `src/inbound.ts`: MAX webhook event parsing and OpenClaw dispatch
- `src/webhook.ts`: local webhook listener scaffold
- `src/types.ts`: MAX account/config types
- `src/config-schema.ts`: runtime config schema object exposed to OpenClaw

## Notes

The repo now has a real inbound text path for `message_created`, native slash-command routing, direct/group access control, and group mention gating. Outbound media/actions are still not implemented yet.
