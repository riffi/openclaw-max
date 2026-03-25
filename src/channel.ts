import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { keepHttpServerTaskAlive } from "openclaw/plugin-sdk/channel-lifecycle";
import { listNativeCommandSpecsForConfig } from "openclaw/plugin-sdk/reply-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { listMaxAccountIds, readAccountConfig, resolveMaxAccount } from "./accounts.js";
import {
  getMaxBotMe,
  registerMaxWebhook,
  sendMaxAttachmentMessage,
  sendMaxChatAction,
  sendMaxTextMessage,
  setMaxBotCommands,
  uploadMaxMedia,
} from "./api.js";
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

const MAX_TEXT_CHUNK_LIMIT = 3800;

function normalizeMaxTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^(max|vkmax):group:/i.test(trimmed)) {
    return trimmed.replace(/^(max|vkmax):group:/i, "group:");
  }
  const normalized = trimmed.replace(/^(max|vkmax):/i, "");
  if (/^-/.test(normalized) && !/^group:/i.test(normalized)) {
    return `group:${normalized}`;
  }
  return normalized;
}

function looksLikeMaxTarget(raw: string): boolean {
  return /^[0-9A-Za-z:_-]+$/.test(raw.trim());
}

function resolveMaxTarget(raw: string): { chatId?: string; userId?: string } {
  const trimmedTarget = raw.trim();
  const isGroup = /^group:/i.test(trimmedTarget) || /^-/.test(trimmedTarget);
  const targetId = trimmedTarget.replace(/^group:/i, "");
  return isGroup ? { chatId: targetId } : { userId: targetId };
}

function resolveMaxUploadType(kind: string | undefined): "image" | "video" | "audio" | "file" {
  if (kind === "image") {
    return "image";
  }
  if (kind === "video") {
    return "video";
  }
  if (kind === "audio") {
    return "audio";
  }
  return "file";
}

function resolveSendingAction(kind: string | undefined):
  | "sending_photo"
  | "sending_video"
  | "sending_audio"
  | "sending_file" {
  if (kind === "image") {
    return "sending_photo";
  }
  if (kind === "video") {
    return "sending_video";
  }
  if (kind === "audio") {
    return "sending_audio";
  }
  return "sending_file";
}

function splitLongMaxChunk(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut <= 0) {
      cut = limit;
    }
    const chunk = remaining.slice(0, cut).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function chunkMaxMarkdownText(text: string, limit: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= limit) {
    return [normalized];
  }

  const chunks: string[] = [];
  let current = "";
  const paragraphs = normalized.split(/\n{2,}/);

  const flushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = "";
  };

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) {
      continue;
    }

    const candidate = current ? `${current}\n\n${trimmedParagraph}` : trimmedParagraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      flushCurrent();
    }

    if (trimmedParagraph.length <= limit) {
      current = trimmedParagraph;
      continue;
    }

    const lines = trimmedParagraph.split("\n");
    for (const line of lines) {
      const trimmedLine = line.trimEnd();
      if (!trimmedLine) {
        continue;
      }
      const lineCandidate = current ? `${current}\n${trimmedLine}` : trimmedLine;
      if (lineCandidate.length <= limit) {
        current = lineCandidate;
        continue;
      }

      if (current) {
        flushCurrent();
      }

      if (trimmedLine.length <= limit) {
        current = trimmedLine;
        continue;
      }

      for (const part of splitLongMaxChunk(trimmedLine, limit)) {
        chunks.push(part);
      }
    }
  }

  if (current) {
    flushCurrent();
  }

  return chunks;
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
    chunker: chunkMaxMarkdownText,
    chunkerMode: "markdown",
    textChunkLimit: MAX_TEXT_CHUNK_LIMIT,
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveMaxAccount(cfg, accountId);
      if (!account.token) {
        throw new Error(`MAX token not configured for account "${account.accountId}"`);
      }
      const result = await sendMaxTextMessage({
        token: account.token,
        apiBaseUrl: account.config.apiBaseUrl,
        ...resolveMaxTarget(to),
        text,
      });
      return {
        channel: "max",
        ok: true,
        messageId: result.messageId,
        chatId: result.chatId,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, accountId, cfg }) => {
      const account = resolveMaxAccount(cfg, accountId);
      if (!account.token) {
        throw new Error(`MAX token not configured for account "${account.accountId}"`);
      }
      const target = resolveMaxTarget(to);
      const media = await loadWebMediaRaw(mediaUrl, {
        localRoots: mediaLocalRoots,
      });
      const uploadType = resolveMaxUploadType(media.kind);

      if (target.chatId) {
        await sendMaxChatAction({
          token: account.token,
          apiBaseUrl: account.config.apiBaseUrl,
          chatId: target.chatId,
          action: resolveSendingAction(media.kind),
        });
      }

      const attachment = await uploadMaxMedia({
        token: account.token,
        apiBaseUrl: account.config.apiBaseUrl,
        type: uploadType,
        buffer: media.buffer,
        fileName: media.fileName ?? "attachment",
        contentType:
          ("contentType" in media && typeof media.contentType === "string" ? media.contentType : undefined) ??
          ("mimeType" in media && typeof media.mimeType === "string" ? media.mimeType : undefined),
        sourceUrl: mediaUrl,
      });

      const result = await sendMaxAttachmentMessage({
        token: account.token,
        apiBaseUrl: account.config.apiBaseUrl,
        ...target,
        attachment,
        ...(text?.trim() ? { text } : {}),
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
