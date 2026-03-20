# openclaw-max

Scaffold for an external OpenClaw channel plugin for VK MAX messenger.

Current state:
- discoverable by the OpenClaw plugin loader
- contains plugin manifest, package metadata, entrypoints, and a minimal channel contract
- includes first runtime slice: account/token resolution, MAX API client, outbound text send, and webhook listener scaffold
- includes inbound `message_created -> OpenClaw reply dispatch -> MAX text reply`
- does not yet implement native slash-command routing, media send, or typing/status actions

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

## Planned implementation slices

1. Native command path for slash commands using `CommandSource: "native"`
2. Outbound media send, `typing_on`, `mark_seen`
3. Better MAX event modeling for replies/callbacks/groups
4. Status, setup, and docs polish

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

The repo now has a real inbound text path for `message_created`, but it is still intentionally incomplete. Slash commands are still unresolved at the Telegram-native level, and outbound media/actions are not implemented yet.
