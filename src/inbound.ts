import { resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/channel-runtime";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/core";
import type { ReplyPayload } from "openclaw/plugin-sdk";
import { resolveMaxAccount } from "./accounts.js";
import { sendMaxTextMessage } from "./api.js";
import type { MaxWebhookEvent, ResolvedMaxAccount } from "./types.js";

type MaxInboundMessage = {
  updateType: string;
  text: string;
  messageId?: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  routeTarget: string;
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
  const isGroup = Boolean(recipientChatId && recipientChatId !== senderId);
  return {
    updateType: event.update_type,
    text,
    messageId: asString(message?.message_id) || asString(message?.id),
    chatId,
    senderId,
    senderName: buildSenderName(message?.sender) || buildSenderName(event.user),
    senderUsername: message?.sender?.username?.trim() || event.user?.username?.trim() || undefined,
    timestamp: message?.timestamp ?? event.timestamp,
    chatType: isGroup ? "group" : "direct",
    routeTarget: isGroup ? chatId : senderId,
  };
}

function isAllowedSender(account: ResolvedMaxAccount, senderId: string): boolean {
  const allowFrom = account.config.allowFrom ?? [];
  if (allowFrom.length === 0) {
    return true;
  }
  const allowed = new Set(
    allowFrom.map((entry) => String(entry).replace(/^(max|vkmax):/i, "").trim()).filter(Boolean),
  );
  return allowed.has(senderId);
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
  if (!isAllowedSender(account, inbound.senderId)) {
    gateway.log?.info?.(
      `[${gateway.accountId}] ignoring MAX sender ${inbound.senderId} (not in allowFrom)`,
    );
    return;
  }

  const runtime = gateway.channelRuntime;
  if (!runtime) {
    gateway.log?.warn?.(`[${gateway.accountId}] channelRuntime unavailable; inbound skipped`);
    return;
  }

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
      id: inbound.routeTarget,
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
    from: inbound.chatType === "group" ? `group:${inbound.chatId}` : inbound.senderName ?? inbound.senderId,
    timestamp: inbound.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: inbound.text,
  });

  const nativeCommand = isNativeSlashCandidate(inbound.text);
  const nativeTargets = nativeCommand
    ? resolveNativeCommandSessionTargets({
        agentId: route.agentId,
        sessionPrefix: "max:slash",
        userId: inbound.senderId,
        targetSessionKey: route.sessionKey,
      })
    : null;

  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: nativeCommand ? inbound.text : body,
    BodyForAgent: inbound.text,
    RawBody: inbound.text,
    CommandBody: inbound.text,
    BodyForCommands: inbound.text,
    From: buildFrom(inbound.routeTarget, inbound),
    To: nativeCommand
      ? `slash:${inbound.senderId}`
      : inbound.chatType === "group"
        ? `max:group:${inbound.chatId}`
        : `max:${inbound.senderId}`,
    SessionKey: nativeTargets?.sessionKey ?? route.sessionKey,
    AccountId: gateway.accountId,
    ChatType: inbound.chatType,
    ConversationLabel:
      inbound.chatType === "group"
        ? `MAX group ${inbound.chatId}`
        : inbound.senderName ?? inbound.senderId,
    SenderName: inbound.senderName,
    SenderId: inbound.senderId,
    SenderUsername: inbound.senderUsername,
    Provider: "max",
    Surface: "max",
    MessageSid: inbound.messageId,
    Timestamp: inbound.timestamp,
    WasMentioned: nativeCommand ? true : undefined,
    CommandAuthorized: true,
    CommandSource: nativeCommand ? ("native" as const) : undefined,
    CommandTargetSessionKey: nativeTargets?.commandTargetSessionKey,
    OriginatingChannel: "max" as const,
    OriginatingTo: inbound.routeTarget,
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

  await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: gateway.cfg,
    dispatcherOptions: {
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text?.trim();
        if (!text) {
          return;
        }
        await sendMaxTextMessage({
          token: account.token,
          apiBaseUrl: account.config.apiBaseUrl,
          chatId: inbound.chatId,
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
}
