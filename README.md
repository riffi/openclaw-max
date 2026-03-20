# openclaw-max

Scaffold for an external OpenClaw channel plugin for VK MAX messenger.

Current state:
- discoverable by the OpenClaw plugin loader
- contains plugin manifest, package metadata, entrypoints, and a minimal channel contract
- includes first runtime slice: account/token resolution, MAX API client, outbound text send, and webhook listener scaffold
- includes inbound `message_created -> OpenClaw reply dispatch -> MAX text reply`
- includes native slash-command routing through the Gateway command path
- does not yet implement media send or typing/status actions

## Goal

This plugin is intended to become a proper `MAX` channel adapter for OpenClaw so that:
- inbound MAX messages go through the Gateway channel pipeline
- registered slash commands are resolved by Gateway, like Telegram native commands
- directives such as `/model` are applied before model execution
- outbound replies, media, typing indicators, and `mark_seen` are sent through MAX Bot API

## Local loading during development

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

Then restart the OpenClaw gateway.

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
      allowFrom: [7678432, "group:242610078"]
    }
  }
}
```

Behavior:

- in direct chats, only explicitly allowed user ids are accepted
- in groups, if the group id is allowed, any participant in that group may talk to the bot
- entries prefixed as `max:...` also work, for example `max:group:242610078`

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

The repo now has a real inbound text path for `message_created`, native slash-command routing, and basic `allowFrom` filtering for direct chats and groups. Outbound media/actions are still not implemented yet.
