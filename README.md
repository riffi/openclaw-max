# openclaw-max

External OpenClaw channel plugin for VK MAX messenger.

Current state:
- includes inbound `message_created -> OpenClaw reply dispatch -> MAX text reply`
- includes native slash-command routing through the Gateway command path
- registers native MAX bot commands from the OpenClaw command catalog
- includes direct/group `allowFrom`
- includes optional mention-only behavior for groups
- sends `mark_seen` and `typing_on` while the agent is working
- sends text replies as `markdown`
- sends outbound media attachments through MAX uploads API
- preserves media MIME type during upload

## Goal

This plugin is intended to become a proper `MAX` channel adapter for OpenClaw so that:
- inbound MAX messages go through the Gateway channel pipeline
- registered slash commands are resolved by Gateway, like Telegram native commands
- directives such as `/model` are applied before model execution
- outbound replies, media, typing indicators, and `mark_seen` are sent through MAX Bot API

## Requirements

- OpenClaw current `main` or a recent build that exports:
  - `openclaw/plugin-sdk/channel-lifecycle`
  - `openclaw/plugin-sdk/reply-runtime`
- a created MAX bot with a valid bot token
- a public HTTPS webhook URL reachable by MAX
- if you want group messages, the bot must be an admin in that MAX group
- for image-heavy automation, a working browser-capable OpenClaw deployment is still recommended

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
    shm_size: 2gb
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
      traefik.http.routers.max-plugin.tls: "true"
      traefik.http.routers.max-plugin.rule: Host(`max.example.com`)
      traefik.http.routers.max-plugin.tls.certresolver: letsencrypt
      traefik.http.routers.max-plugin.service: max-plugin
      traefik.http.services.max-plugin.loadbalancer.server.port: "8788"

networks:
  web:
    external: true
```

`shm_size: 2gb` is recommended because many OpenClaw installs also use browser tooling in the same gateway container.

### 3. Enable the plugin in `openclaw.json`

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
- register native MAX commands
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
[max] [default] MAX native commands registered (<n>)
[max] [default] MAX webhook registered
[max] [default] MAX webhook listener started on http://0.0.0.0:8788/webhook
```

Then test in MAX:

- direct chat: send `hello`
- direct chat: send `/status`
- group chat: send `@your_bot hello`
- group chat: send `/status`

If `groupRequireMention` is `true`, plain group text without mention is ignored, but standalone slash commands still work for allowed senders.

### 7. Traefik note

In one real deployment, Traefik did not pick up the Docker labels for `max.example.com` after rebuilding the OpenClaw image, even though the labels were present on the container.

The practical fallback was a file-provider route:

```yaml
http:
  routers:
    max-plugin-file:
      entryPoints:
        - websecure
      rule: Host(`max.example.com`)
      service: max-plugin-file
      tls:
        certResolver: letsencrypt
  services:
    max-plugin-file:
      loadBalancer:
        servers:
          - url: http://openclaw-openclaw-gateway-1:8788
```

Example path:

```text
/opt/traefik/dynamic/max-plugin.yml
```

If Docker-label routing works in your environment, you do not need this fallback. If `https://max.example.com/healthz` returns Traefik `404 page not found` while the plugin listener is alive inside the gateway, this fallback is the fastest fix.

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
- native MAX bot commands are also registered through `PATCH /me { commands: [...] }`
- on a recent OpenClaw build this list is taken from the system native command catalog, not from a hardcoded static list

## Delivery behavior

- incoming accepted messages trigger `mark_seen`
- the plugin sends `typing_on` immediately
- while the reply is being generated, `typing_on` is refreshed every 4 seconds
- text replies are sent with `format: "markdown"`
- outbound media uses MAX uploads API and then sends attachments through `POST /messages`
- local files work, for example `MEDIA:/home/node/.openclaw/workspace/file.jpg`
- remote media URLs are fetched by OpenClaw and then re-uploaded to MAX by the plugin

## Media

This plugin now supports outbound media.

What works:

- image attachments from local workspace files
- image attachments from remote URLs after OpenClaw resolves them to media
- captions together with attachments
- chat actions such as `sending_photo` before delivery

Important notes:

- MAX upload is sensitive to the actual file contents; if the file is HTML or text with a `.jpg` suffix, MAX will reject it
- the plugin now preserves media MIME type during upload, which is required for some images to be accepted reliably
- if OpenClaw emits `MEDIA:/...`, the referenced file must be a real image/video/audio/file, not an error page saved with the wrong extension

## Recommended Image Flow

The most reliable pattern for "find an image on the internet and send it" is:

1. Search for a candidate image source
2. Validate headers / content type
3. Download to the workspace
4. Validate the saved file
5. Return `MEDIA:/...`

A practical helper used in a real deployment:

```bash
python3 /home/node/.openclaw/workspace/bin/fetch_openverse_image.py \
  "zucchini" \
  /home/node/.openclaw/workspace/zucchini
```

That helper:

- searches Openverse API
- sets a non-empty `User-Agent`
- checks `Content-Type`
- downloads the first valid image
- validates the downloaded file signature

This avoids the common failure mode where the agent guesses raw Wikimedia URLs and saves `HTML` or rate-limit pages as `.jpg`.

If your deployment has a workspace instruction layer like `AGENTS.md` / `TOOLS.md`, it is worth documenting this helper there so the agent prefers it over raw hotlink guessing.

## Still missing

1. Better MAX event modeling for replies/callbacks/groups
2. Setup/test automation and docs polish
3. More robust handling for every MAX upload response variant and recovery queue cleanup

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

The repo now has a real inbound text path for `message_created`, OpenClaw-native slash-command routing, dynamic MAX command registration, direct/group access control, group mention gating, read/typing indicators, markdown text replies, and outbound media delivery.
