import type { MaxApiRequestOptions } from "./types.js";

type MaxApiEnvelope<T> = {
  ok?: boolean;
  success?: boolean;
  result?: T;
  [key: string]: unknown;
};

function resolveApiBaseUrl(apiBaseUrl?: string): string {
  return (apiBaseUrl?.trim() || "https://platform-api.max.ru").replace(/\/+$/, "");
}

async function maxApiRequest<T>(
  path: string,
  init: RequestInit & MaxApiRequestOptions,
): Promise<T> {
  const response = await fetch(`${resolveApiBaseUrl(init.apiBaseUrl)}${path}`, {
    method: init.method,
    headers: {
      Authorization: init.token,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body,
    signal: init.signal,
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as MaxApiEnvelope<T> | T) : ({} as T);

  if (!response.ok) {
    throw new Error(`MAX API ${response.status}: ${text || response.statusText}`);
  }

  if (parsed && typeof parsed === "object" && "result" in (parsed as Record<string, unknown>)) {
    return (parsed as MaxApiEnvelope<T>).result as T;
  }

  return parsed as T;
}

export async function getMaxBotMe(params: MaxApiRequestOptions): Promise<Record<string, unknown>> {
  return await maxApiRequest<Record<string, unknown>>("/me", {
    method: "GET",
    ...params,
  });
}

export async function sendMaxTextMessage(params: {
  token: string;
  apiBaseUrl?: string;
  chatId?: string;
  userId?: string;
  text: string;
  format?: "markdown" | "html";
  signal?: AbortSignal;
}): Promise<{ messageId?: string; chatId?: string; userId?: string }> {
  const targetQuery = params.chatId
    ? `chat_id=${encodeURIComponent(params.chatId)}`
    : params.userId
      ? `user_id=${encodeURIComponent(params.userId)}`
      : null;
  if (!targetQuery) {
    throw new Error("MAX send requires either chatId or userId");
  }
  const result = await maxApiRequest<Record<string, unknown>>(
    `/messages?${targetQuery}`,
    {
      method: "POST",
      body: JSON.stringify({
        text: params.text,
        ...(params.format ? { format: params.format } : {}),
      }),
      token: params.token,
      apiBaseUrl: params.apiBaseUrl,
      signal: params.signal,
    },
  );

  return {
    messageId:
      typeof result.message_id === "string" || typeof result.message_id === "number"
        ? String(result.message_id)
        : undefined,
    chatId: params.chatId,
    userId: params.userId,
  };
}

export async function sendMaxChatAction(params: {
  token: string;
  apiBaseUrl?: string;
  chatId: string;
  action: "typing_on" | "sending_photo" | "sending_video" | "sending_audio" | "sending_file" | "mark_seen";
  signal?: AbortSignal;
}): Promise<void> {
  await maxApiRequest<Record<string, unknown>>(
    `/chats/${encodeURIComponent(params.chatId)}/actions`,
    {
      method: "POST",
      body: JSON.stringify({
        action: params.action,
      }),
      token: params.token,
      apiBaseUrl: params.apiBaseUrl,
      signal: params.signal,
    },
  );
}

export async function registerMaxWebhook(params: {
  token: string;
  apiBaseUrl?: string;
  url: string;
  secret?: string;
  updateTypes?: string[];
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return await maxApiRequest<Record<string, unknown>>("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      url: params.url,
      secret: params.secret,
      update_types: params.updateTypes ?? ["message_created", "bot_started"],
    }),
    token: params.token,
    apiBaseUrl: params.apiBaseUrl,
    signal: params.signal,
  });
}
