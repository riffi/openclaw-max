import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { keepHttpServerTaskAlive } from "openclaw/plugin-sdk/channel-lifecycle";
import { listNativeCommandSpecsForConfig } from "openclaw/plugin-sdk/reply-runtime";
import { listMaxAccountIds, readAccountConfig, resolveMaxAccount } from "./accounts.js";
import { getMaxBotMe, registerMaxWebhook, sendMaxTextMessage, setMaxBotCommands } from "./api.js";
import { MaxChannelConfigSchema } from "./config-schema.js";
import { handleMaxInboundEvent } from "./inbound.js";
import { setMaxBotUsername } from "./runtime.js";
import { DEFAULT_ACCOUNT_ID, type MaxBotCommand, type ResolvedMaxAccount } from "./types.js";
import { startMaxWebhookServer } from "./webhook.js";

const meta = {
  id: "max",
  label: "MAX",
  selectionLabel: "MAX Messenger",
  docsPath: "/channels/max",
  docsLabel: "max",
  blurb: "VK MAX messenger Bot API integration for OpenClaw.",
  aliases: ["vkmax"],
  order: 95,
  quickstartAllowFrom: true,
} as const;

function normalizeMaxTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^(max|vkmax):group:/i.test(trimmed)) {
    return trimmed.replace(/^(max|vkmax):group:/i, "group:");
  }
  return trimmed.replace(/^(max|vkmax):/i, "");
}

function looksLikeMaxTarget(raw: string): boolean {
  return /^[0-9A-Za-z:_-]+$/.test(raw.trim());
}

const DEFAULT_MAX_NATIVE_COMMANDS: MaxBotCommand[] = [
  { name: "help", description: "Show available commands." },
  { name: "commands", description: "List all slash commands." },
  { name: "status", description: "Show current status." },
  { name: "whoami", description: "Show your sender id." },
  { name: "model", description: "Show or set the model." },
  { name: "reset", description: "Reset the current session." },
  { name: "new", description: "Start a new session." },
  { name: "think", description: "Set thinking level." },
  { name: "verbose", description: "Toggle verbose mode." },
  { name: "reasoning", description: "Toggle reasoning visibility." },
  { name: "usage", description: "Usage footer or cost summary." },
  { name: "stop", description: "Stop the current run." },
];

function resolveMaxNativeCommands(cfg: Parameters<typeof listNativeCommandSpecsForConfig>[0]): MaxBotCommand[] {
  const commands = listNativeCommandSpecsForConfig(cfg, { provider: "max" })
    .filter((command) => command.name.trim())
    .slice(0, 32)
    .map((command) => ({
      name: command.name.trim(),
      description: command.description?.trim() || command.name.trim(),
    }));
  return commands.length > 0 ? commands : DEFAULT_MAX_NATIVE_COMMANDS;
}

export const maxPlugin: ChannelPlugin<ResolvedMaxAccount> = {
  id: "max",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: {
    configPrefixes: ["channels.max"],
  },
  configSchema: MaxChannelConfigSchema,
  config: {
    listAccountIds: listMaxAccountIds,
    resolveAccount: resolveMaxAccount,
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.tokenSource !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.tokenSource !== "none",
      tokenSource: account.tokenSource,
      webhookUrl: account.config.webhookUrl ?? null,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => readAccountConfig(cfg, accountId).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).replace(/^(max|vkmax):/i, "")),
  },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx.account.token) {
        throw new Error(`MAX token not configured for account "${ctx.accountId}"`);
      }

      const me = await getMaxBotMe({
        token: ctx.account.token,
        apiBaseUrl: ctx.account.config.apiBaseUrl,
        signal: ctx.abortSignal,
      });
      ctx.log?.info?.(
        `[${ctx.accountId}] MAX bot authenticated${typeof me.username === "string" ? ` as ${me.username}` : ""}`,
      );
      setMaxBotUsername(ctx.accountId, typeof me.username === "string" ? me.username : undefined);
      const nativeCommands = resolveMaxNativeCommands(ctx.cfg);
      if (nativeCommands.length > 0) {
        await setMaxBotCommands({
          token: ctx.account.token,
          apiBaseUrl: ctx.account.config.apiBaseUrl,
          commands: nativeCommands,
          signal: ctx.abortSignal,
        });
        ctx.log?.info?.(
          `[${ctx.accountId}] MAX native commands registered (${nativeCommands.length})`,
        );
      }

      if (ctx.account.config.webhookUrl?.trim()) {
        await registerMaxWebhook({
          token: ctx.account.token,
          apiBaseUrl: ctx.account.config.apiBaseUrl,
          url: ctx.account.config.webhookUrl.trim(),
          secret: ctx.account.config.webhookSecret?.trim(),
          signal: ctx.abortSignal,
        });
        ctx.log?.info?.(`[${ctx.accountId}] MAX webhook registered`);
      }

      const server = await startMaxWebhookServer({
        account: ctx.account,
        runtime: ctx.runtime,
        log: ctx.log,
        abortSignal: ctx.abortSignal,
        onEvent: async (event) => {
          await handleMaxInboundEvent({
            gateway: ctx,
            event,
          });
        },
      });

      await keepHttpServerTaskAlive({
        server,
        abortSignal: ctx.abortSignal,
      });
    },
    stopAccount: async () => {
      // Server lifecycle is tied to abort signal in the current scaffold.
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveMaxAccount(cfg, accountId);
      if (!account.token) {
        throw new Error(`MAX token not configured for account "${account.accountId}"`);
      }
      const trimmedTarget = to.trim();
      const isGroup = /^group:/i.test(trimmedTarget);
      const targetId = trimmedTarget.replace(/^group:/i, "");
      const result = await sendMaxTextMessage({
        token: account.token,
        apiBaseUrl: account.config.apiBaseUrl,
        ...(isGroup ? { chatId: targetId } : { userId: targetId }),
        text,
      });
      return {
        channel: "max",
        ok: true,
        messageId: result.messageId,
        chatId: result.chatId,
      };
    },
  },
  messaging: {
    normalizeTarget: normalizeMaxTarget,
    targetResolver: {
      looksLikeId: looksLikeMaxTarget,
      hint: "<chatId>",
    },
  },
};
