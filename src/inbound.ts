import type { ChannelGatewayContext } from "openclaw/plugin-sdk/core";
import type { ReplyPayload } from "openclaw/plugin-sdk";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { resolveMaxAccount } from "./accounts.js";
import { sendMaxAttachmentMessage, sendMaxChatAction, sendMaxTextMessage, uploadMaxMedia } from "./api.js";
import { getMaxBotUsername } from "./runtime.js";
import type { MaxWebhookEvent, ResolvedMaxAccount } from "./types.js";

type MaxInboundMessage = {
  updateType: string;
  text: string;
  messageId?: string;
  chatId: string;
  replyChatId?: string;
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  routeTarget: string;
  wasMentioned?: boolean;
};

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function buildSenderName(
  value:
    | {
        first_name?: string | null;
        last_name?: string | null;
        name?: string | null;
      }
    | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const combined = [value.first_name?.trim(), value.last_name?.trim()].filter(Boolean).join(" ");
  return combined || value.name?.trim() || undefined;
}

function isMaxGroupChatId(chatId: string): boolean {
  return /^-/.test(chatId.trim());
}

function resolveInboundMessage(event: MaxWebhookEvent): MaxInboundMessage | null {
  if (event.update_type !== "message_created") {
    return null;
  }

  const message = event.message;
  const text = message?.body?.text?.trim() || message?.text?.trim();
  if (!text) {
    return null;
  }

  const recipientChatId = asString(message?.recipient?.chat_id);
  const eventChatId = asString(event.chat_id);
  const senderId = asString(message?.sender?.user_id) || asString(event.user_id);
  if (!senderId) {
    return null;
  }

  const chatId = recipientChatId || eventChatId || senderId;
  const isGroup = isMaxGroupChatId(chatId);
  return {
    updateType: event.update_type,
    text,
    messageId: asString(message?.message_id) || asString(message?.id),
    chatId,
    replyChatId: recipientChatId || eventChatId || undefined,
    senderId,
    senderName: buildSenderName(message?.sender) || buildSenderName(event.user),
    senderUsername: message?.sender?.username?.trim() || event.user?.username?.trim() || undefined,
    timestamp: message?.timestamp ?? event.timestamp,
    chatType: isGroup ? "group" : "direct",
    routeTarget: isGroup ? chatId : senderId,
  };
}

function normalizeAllowFromEntry(value: string | number): string {
  return String(value).trim().replace(/^(max|vkmax):/i, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripGroupMention(text: string, botUsername?: string): { text: string; wasMentioned: boolean } {
  const trimmed = text.trim();
  const username = botUsername?.trim();
  if (!username) {
    return { text: trimmed, wasMentioned: false };
  }

  const mentionPattern = new RegExp(`(^|\\s)@${escapeRegExp(username)}(?=\\s|$|[,:;.!?])`, "i");
  if (!mentionPattern.test(trimmed)) {
    return { text: trimmed, wasMentioned: false };
  }

  const withoutMention = trimmed.replace(new RegExp(`@${escapeRegExp(username)}(?=\\s|$|[,:;.!?])`, "ig"), " ");
  return {
    text: withoutMention.replace(/\s+/g, " ").trim(),
    wasMentioned: true,
  };
}

function isAllowedSender(account: ResolvedMaxAccount, inbound: MaxInboundMessage): boolean {
  const allowFrom = account.config.allowFrom ?? [];
  if (allowFrom.length === 0) {
    return true;
  }

  const allowed = new Set(allowFrom.map(normalizeAllowFromEntry).filter(Boolean));
  if (inbound.chatType === "group") {
    return allowed.has(`group:${inbound.chatId}`) || allowed.has(inbound.chatId);
  }

  return allowed.has(inbound.senderId);
}

function buildFrom(channelId: string, input: MaxInboundMessage): string {
  if (input.chatType === "group") {
    return `max:group:${channelId}`;
  }
  return `max:${channelId}`;
}

function isNativeSlashCandidate(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function resolveNativeCommandSessionTargets(params: {
  agentId: string;
  sessionPrefix: string;
  userId: string;
  targetSessionKey: string;
  boundSessionKey?: string;
  lowercaseSessionKey?: boolean;
}) {
  const rawSessionKey =
    params.boundSessionKey ?? `agent:${params.agentId}:${params.sessionPrefix}:${params.userId}`;
  return {
    sessionKey: params.lowercaseSessionKey ? rawSessionKey.toLowerCase() : rawSessionKey,
    commandTargetSessionKey: params.boundSessionKey ?? params.targetSessionKey,
  };
}

async function sendMaxActionBestEffort(params: {
  token: string;
  apiBaseUrl?: string;
  chatId: string;
  action: "typing_on" | "mark_seen";
  gateway: ChannelGatewayContext<ResolvedMaxAccount>;
}): Promise<void> {
  try {
    await sendMaxChatAction({
      token: params.token,
      apiBaseUrl: params.apiBaseUrl,
      chatId: params.chatId,
      action: params.action,
    });
  } catch (error) {
    params.gateway.log?.warn?.(
      `[${params.gateway.accountId}] MAX action ${params.action} failed: ${String(error)}`,
    );
  }
}

function resolvePayloadMediaUrls(payload: ReplyPayload): string[] {
  if (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0) {
    return payload.mediaUrls.map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()) {
    return [payload.mediaUrl.trim()];
  }
  return [];
}

function resolveOutboundTarget(input: MaxInboundMessage):
  | { chatId: string }
  | { userId: string } {
  if (input.replyChatId) {
    return { chatId: input.replyChatId };
  }
  if (input.chatType === "group") {
    return { chatId: input.chatId };
  }
  return { userId: input.senderId };
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

export async function handleMaxInboundEvent(params: {
  gateway: ChannelGatewayContext<ResolvedMaxAccount>;
  event: MaxWebhookEvent;
}): Promise<void> {
  const inbound = resolveInboundMessage(params.event);
  if (!inbound) {
    return;
  }

  const { gateway } = params;
  const account = resolveMaxAccount(gateway.cfg, gateway.accountId);
  const botUsername = getMaxBotUsername(gateway.accountId);
  const mentionResult =
    inbound.chatType === "group"
      ? stripGroupMention(inbound.text, botUsername)
      : { text: inbound.text, wasMentioned: false };
  const normalizedInbound = {
    ...inbound,
    text: mentionResult.text || inbound.text,
    wasMentioned: mentionResult.wasMentioned,
  };
  const nativeCommand = isNativeSlashCandidate(normalizedInbound.text);
  if (!isAllowedSender(account, normalizedInbound)) {
    gateway.log?.info?.(
      `[${gateway.accountId}] ignoring MAX ${
        normalizedInbound.chatType === "group"
          ? `group ${normalizedInbound.chatId}`
          : `sender ${normalizedInbound.senderId}`
      } (not in allowFrom)`,
    );
    return;
  }
  const groupRequireMention = account.config.groupRequireMention === true;
  if (
    normalizedInbound.chatType === "group" &&
    groupRequireMention &&
    !normalizedInbound.wasMentioned &&
    !nativeCommand
  ) {
    gateway.log?.info?.(
      `[${gateway.accountId}] ignoring MAX group ${normalizedInbound.chatId} message without bot mention`,
    );
    return;
  }

  const runtime = gateway.channelRuntime;
  if (!runtime) {
    gateway.log?.warn?.(`[${gateway.accountId}] channelRuntime unavailable; inbound skipped`);
    return;
  }
  const actionChatId = normalizedInbound.replyChatId ?? normalizedInbound.chatId;
  await sendMaxActionBestEffort({
    token: account.token,
    apiBaseUrl: account.config.apiBaseUrl,
    chatId: actionChatId,
    action: "mark_seen",
    gateway,
  });
  await sendMaxActionBestEffort({
    token: account.token,
    apiBaseUrl: account.config.apiBaseUrl,
    chatId: actionChatId,
    action: "typing_on",
    gateway,
  });
  const typingTimer = setInterval(() => {
    void sendMaxActionBestEffort({
      token: account.token,
      apiBaseUrl: account.config.apiBaseUrl,
      chatId: actionChatId,
      action: "typing_on",
      gateway,
    });
  }, 4000);

  runtime.activity.record({
    channel: "max",
    accountId: gateway.accountId,
    direction: "inbound",
  });

  const route = runtime.routing.resolveAgentRoute({
    cfg: gateway.cfg,
    channel: "max",
    accountId: gateway.accountId,
    peer: {
      kind: inbound.chatType === "group" ? "group" : "direct",
      id: normalizedInbound.routeTarget,
    },
  });
  const storePath = runtime.session.resolveStorePath(gateway.cfg.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeOptions = runtime.reply.resolveEnvelopeFormatOptions(gateway.cfg);
  const body = runtime.reply.formatAgentEnvelope({
    channel: "MAX",
    from:
      normalizedInbound.chatType === "group"
        ? `group:${normalizedInbound.chatId}`
        : normalizedInbound.senderName ?? normalizedInbound.senderId,
    timestamp: normalizedInbound.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: normalizedInbound.text,
  });

  const nativeTargets = nativeCommand
    ? resolveNativeCommandSessionTargets({
        agentId: route.agentId,
        sessionPrefix: "max:slash",
        userId: normalizedInbound.senderId,
        targetSessionKey: route.sessionKey,
      })
    : null;

  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: nativeCommand ? normalizedInbound.text : body,
    BodyForAgent: normalizedInbound.text,
    RawBody: normalizedInbound.text,
    CommandBody: normalizedInbound.text,
    BodyForCommands: normalizedInbound.text,
    From: buildFrom(normalizedInbound.routeTarget, normalizedInbound),
    To: nativeCommand
      ? `slash:${normalizedInbound.senderId}`
      : normalizedInbound.chatType === "group"
        ? `max:group:${normalizedInbound.chatId}`
        : `max:${normalizedInbound.senderId}`,
    SessionKey: nativeTargets?.sessionKey ?? route.sessionKey,
    AccountId: gateway.accountId,
    ChatType: normalizedInbound.chatType,
    ConversationLabel:
      normalizedInbound.chatType === "group"
        ? `MAX group ${normalizedInbound.chatId}`
        : normalizedInbound.senderName ?? normalizedInbound.senderId,
    SenderName: normalizedInbound.senderName,
    SenderId: normalizedInbound.senderId,
    SenderUsername: normalizedInbound.senderUsername,
    Provider: "max",
    Surface: "max",
    MessageSid: normalizedInbound.messageId,
    Timestamp: normalizedInbound.timestamp,
    WasMentioned: nativeCommand ? true : normalizedInbound.wasMentioned || undefined,
    CommandAuthorized: true,
    CommandSource: nativeCommand ? ("native" as const) : undefined,
    CommandTargetSessionKey: nativeTargets?.commandTargetSessionKey,
    OriginatingChannel: "max" as const,
    OriginatingTo: normalizedInbound.routeTarget,
  });

  await runtime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (error) => {
      gateway.log?.error?.(
        `[${gateway.accountId}] MAX inbound session record failed: ${String(error)}`,
      );
    },
  });

  try {
    await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: gateway.cfg,
      dispatcherOptions: {
        deliver: async (payload: ReplyPayload) => {
          const text = payload.text?.trim();
          const mediaUrls = resolvePayloadMediaUrls(payload);
          const target = resolveOutboundTarget(normalizedInbound);

          if (mediaUrls.length > 0) {
            for (const [index, mediaUrl] of mediaUrls.entries()) {
              const media = await loadWebMediaRaw(mediaUrl);
              const uploadType = resolveMaxUploadType(media.kind);

              await sendMaxChatAction({
                token: account.token,
                apiBaseUrl: account.config.apiBaseUrl,
                chatId: actionChatId,
                action: resolveSendingAction(media.kind),
              });

              const attachment = await uploadMaxMedia({
                token: account.token,
                apiBaseUrl: account.config.apiBaseUrl,
                type: uploadType,
                buffer: media.buffer,
                fileName: media.fileName ?? `attachment-${index + 1}`,
                contentType:
                  ("contentType" in media && typeof media.contentType === "string" ? media.contentType : undefined) ??
                  ("mimeType" in media && typeof media.mimeType === "string" ? media.mimeType : undefined),
                sourceUrl: mediaUrl,
              });

              await sendMaxAttachmentMessage({
                token: account.token,
                apiBaseUrl: account.config.apiBaseUrl,
                ...target,
                attachment,
                ...(index === 0 && text ? { text } : {}),
              });
            }
            return;
          }

          if (!text) {
            return;
          }
          await sendMaxTextMessage({
            token: account.token,
            apiBaseUrl: account.config.apiBaseUrl,
            ...target,
            text,
          });
        },
        onError: (error, info) => {
          gateway.log?.error?.(
            `[${gateway.accountId}] MAX dispatch ${info.kind} failed: ${String(error)}`,
          );
        },
      },
    });
  } finally {
    clearInterval(typingTimer);
  }
}
