import type { ChannelGatewayContext } from "openclaw/plugin-sdk/core";
import type { ReplyPayload } from "openclaw/plugin-sdk";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { resolveMaxAccount } from "./accounts.js";
import {
  getMaxBotMe,
  sendMaxAttachmentMessage,
  sendMaxChatAction,
  sendMaxTextMessage,
  uploadMaxMedia,
} from "./api.js";
import { getMaxBotUsername, setMaxBotUsername } from "./runtime.js";
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
  mediaUrls?: string[];
  mediaTypes?: string[];
  mediaKinds?: string[];
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

function inferAttachmentMime(type: string | undefined): string | undefined {
  switch (type) {
    case "image":
      return "image/jpeg";
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
    case "file":
      return "application/octet-stream";
    default:
      return undefined;
  }
}

function resolveAttachmentPlaceholder(types: string[]): string {
  if (types.length === 0) {
    return "<media:attachment>";
  }
  const uniqueTypes = Array.from(new Set(types));
  const first = uniqueTypes[0];
  if (uniqueTypes.length === 1) {
    const label =
      first === "image" || first === "video" || first === "audio" ? first : "attachment";
    if (types.length > 1) {
      return `<media:${label}> (${types.length} ${label}${types.length === 1 ? "" : "s"})`;
    }
    return `<media:${label}>`;
  }
  return "<media:attachment>";
}

function resolveInboundMedia(message: MaxWebhookEvent["message"]): {
  mediaUrls: string[];
  mediaTypes: string[];
  mediaKinds: string[];
} {
  const attachments = [
    ...(Array.isArray(message?.body?.attachments) ? message.body.attachments : []),
    ...(Array.isArray(message?.attachments) ? message.attachments : []),
  ];
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];
  const mediaKinds: string[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }
    const type = typeof attachment.type === "string" ? attachment.type.trim().toLowerCase() : "";
    if (!["image", "video", "audio", "file"].includes(type)) {
      continue;
    }

    const directUrl =
      typeof attachment.payload?.url === "string" ? attachment.payload.url.trim() : "";
    const photoUrls =
      attachment.payload?.photos && typeof attachment.payload.photos === "object"
        ? Object.values(attachment.payload.photos)
            .map((entry) => (typeof entry?.url === "string" ? entry.url.trim() : ""))
            .filter(Boolean)
        : [];
    const url = directUrl || photoUrls[0];
    if (!url) {
      continue;
    }

    const mime =
      (typeof attachment.mime_type === "string" && attachment.mime_type.trim()) ||
      (typeof attachment.payload?.mime_type === "string" && attachment.payload.mime_type.trim()) ||
      inferAttachmentMime(type);

    mediaUrls.push(url);
    mediaTypes.push(mime || "");
    mediaKinds.push(type);
  }

  return { mediaUrls, mediaTypes, mediaKinds };
}

function resolveInboundMessage(event: MaxWebhookEvent): MaxInboundMessage | null {
  if (event.update_type !== "message_created") {
    return null;
  }

  const message = event.message;
  const { mediaUrls, mediaTypes, mediaKinds } = resolveInboundMedia(message);
  const text =
    message?.body?.text?.trim() ||
    message?.text?.trim() ||
    (mediaUrls.length > 0 ? resolveAttachmentPlaceholder(mediaKinds) : undefined);
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
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    mediaKinds: mediaKinds.length > 0 ? mediaKinds : undefined,
  };
}

function normalizeAllowFromEntry(value: string | number): string {
  return String(value).trim().replace(/^(max|vkmax):/i, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripGroupMention(text: string, aliases: string[]): { text: string; wasMentioned: boolean } {
  const trimmed = text.trim();
  const normalizedAliases = aliases.map((value) => value.trim()).filter(Boolean);
  if (normalizedAliases.length === 0) {
    return { text: trimmed, wasMentioned: false };
  }

  const aliasPattern = normalizedAliases.map(escapeRegExp).join("|");
  const mentionPattern = new RegExp(`(^|\\s)@(?:${aliasPattern})(?=\\s|$|[,:;.!?])`, "i");
  if (!mentionPattern.test(trimmed)) {
    return { text: trimmed, wasMentioned: false };
  }

  const withoutMention = trimmed.replace(
    new RegExp(`@(?:${aliasPattern})(?=\\s|$|[,:;.!?])`, "ig"),
    " ",
  );
  return {
    text: withoutMention.replace(/\s+/g, " ").trim(),
    wasMentioned: true,
  };
}

async function resolveBotMentionAliases(params: {
  gateway: ChannelGatewayContext<ResolvedMaxAccount>;
  account: ResolvedMaxAccount;
}): Promise<string[]> {
  const aliases = new Set<string>();
  const cachedUsername = getMaxBotUsername(params.gateway.accountId);
  if (cachedUsername?.trim()) {
    aliases.add(cachedUsername.trim());
  }

  if (aliases.size === 0) {
    try {
      const me = await getMaxBotMe({
        token: params.account.token,
        apiBaseUrl: params.account.config.apiBaseUrl,
        signal: params.gateway.abortSignal,
      });
      if (typeof me.username === "string" && me.username.trim()) {
        const username = me.username.trim();
        aliases.add(username);
        setMaxBotUsername(params.gateway.accountId, username);
      }
      if (typeof me.name === "string" && me.name.trim()) {
        aliases.add(me.name.trim());
      } else if (typeof me.first_name === "string" && me.first_name.trim()) {
        aliases.add(me.first_name.trim());
      }
    } catch (error) {
      params.gateway.log?.warn?.(
        `[${params.gateway.accountId}] MAX mention alias refresh failed: ${String(error)}`,
      );
    }
  }

  return Array.from(aliases);
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
  const botMentionAliases =
    inbound.chatType === "group"
      ? await resolveBotMentionAliases({ gateway, account })
      : [];
  const mentionResult =
    inbound.chatType === "group"
      ? stripGroupMention(inbound.text, botMentionAliases)
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
    MediaUrl: normalizedInbound.mediaUrls?.[0],
    MediaUrls: normalizedInbound.mediaUrls,
    MediaType: normalizedInbound.mediaTypes?.[0],
    MediaTypes: normalizedInbound.mediaTypes,
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
