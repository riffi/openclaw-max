import type { MaxApiRequestOptions, MaxBotCommand } from "./types.js";

type MaxTextFormat = "markdown" | "html";

type MaxAttachmentRequest =
  | {
      type: "image";
      payload:
        | { token: string }
        | { url: string }
        | { photos: Record<string, { token: string }> };
    }
  | {
      type: "video" | "audio" | "file";
      payload: { token: string };
    };

type MaxUploadType = "image" | "video" | "audio" | "file";

type MaxSendTarget =
  | {
      chatId: string;
      userId?: never;
    }
  | {
      chatId?: never;
      userId: string;
    };

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

function resolveMessageTargetQuery(target: MaxSendTarget): string {
  if ("chatId" in target && target.chatId) {
    return `chat_id=${encodeURIComponent(target.chatId)}`;
  }
  if ("userId" in target && target.userId) {
    return `user_id=${encodeURIComponent(target.userId)}`;
  }
  throw new Error("MAX send requires either chatId or userId");
}

function resolveSendTarget(params: { chatId?: string; userId?: string }): MaxSendTarget {
  if (params.chatId) {
    return { chatId: params.chatId };
  }
  if (params.userId) {
    return { userId: params.userId };
  }
  throw new Error("MAX send requires either chatId or userId");
}

async function sendMaxMessage(params: MaxApiRequestOptions &
  MaxSendTarget & {
    text?: string;
    format?: MaxTextFormat;
    attachments?: MaxAttachmentRequest[];
  }): Promise<{ messageId?: string; chatId?: string; userId?: string }> {
  const result = await maxApiRequest<Record<string, unknown>>(
    `/messages?${resolveMessageTargetQuery(params)}`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.format ? { format: params.format } : {}),
        ...(params.attachments?.length ? { attachments: params.attachments } : {}),
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
    chatId: "chatId" in params ? params.chatId : undefined,
    userId: "userId" in params ? params.userId : undefined,
  };
}

export async function getMaxBotMe(params: MaxApiRequestOptions): Promise<Record<string, unknown>> {
  return await maxApiRequest<Record<string, unknown>>("/me", {
    method: "GET",
    ...params,
  });
}

export async function setMaxBotCommands(params: {
  token: string;
  apiBaseUrl?: string;
  commands: MaxBotCommand[];
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  return await maxApiRequest<Record<string, unknown>>("/me", {
    method: "PATCH",
    body: JSON.stringify({
      commands: params.commands,
    }),
    token: params.token,
    apiBaseUrl: params.apiBaseUrl,
    signal: params.signal,
  });
}

export async function sendMaxTextMessage(params: {
  token: string;
  apiBaseUrl?: string;
  chatId?: string;
  userId?: string;
  text: string;
  format?: MaxTextFormat;
  signal?: AbortSignal;
}): Promise<{ messageId?: string; chatId?: string; userId?: string }> {
  return await sendMaxMessage({
    token: params.token,
    apiBaseUrl: params.apiBaseUrl,
    ...resolveSendTarget(params),
    text: params.text,
    format: params.format ?? "markdown",
    signal: params.signal,
  });
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

async function getMaxUploadUrl(params: {
  token: string;
  apiBaseUrl?: string;
  type: MaxUploadType;
  signal?: AbortSignal;
}): Promise<{ url: string; token?: string }> {
  return await maxApiRequest<{ url: string; token?: string }>(`/uploads?type=${params.type}`, {
    method: "POST",
    token: params.token,
    apiBaseUrl: params.apiBaseUrl,
    signal: params.signal,
  });
}

async function uploadMaxMultipart(params: {
  uploadUrl: string;
  buffer: Uint8Array;
  fileName: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const body = new FormData();
  body.append(
    "file",
    new Blob([Buffer.from(params.buffer)]),
    params.fileName,
  );
  const response = await fetch(params.uploadUrl, {
    method: "POST",
    body,
    signal: params.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MAX upload ${response.status}: ${text || response.statusText}`);
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function uploadMaxRange(params: {
  uploadUrl: string;
  buffer: Uint8Array;
  fileName: string;
  token: string;
  signal?: AbortSignal;
}): Promise<void> {
  const size = params.buffer.byteLength;
  const response = await fetch(params.uploadUrl, {
    method: "POST",
    body: Buffer.from(params.buffer),
    headers: {
      "Content-Disposition": `attachment; filename="${params.fileName}"`,
      "Content-Range": `bytes 0-${size - 1}/${size}`,
      "Content-Type": "application/x-binary; charset=x-user-defined",
      "X-File-Name": params.fileName,
      "X-Uploading-Mode": "parallel",
      Connection: "keep-alive",
    },
    signal: params.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MAX upload ${response.status}: ${text || response.statusText}`);
  }
}

export async function uploadMaxMedia(params: {
  token: string;
  apiBaseUrl?: string;
  type: MaxUploadType;
  buffer: Uint8Array;
  fileName: string;
  sourceUrl?: string;
  signal?: AbortSignal;
}): Promise<MaxAttachmentRequest> {
  if (params.type === "image" && params.sourceUrl && /^https?:\/\//i.test(params.sourceUrl)) {
    return {
      type: "image",
      payload: { url: params.sourceUrl },
    };
  }

  const upload = await getMaxUploadUrl({
    token: params.token,
    apiBaseUrl: params.apiBaseUrl,
    type: params.type,
    signal: params.signal,
  });

  if (upload.token) {
    await uploadMaxRange({
      uploadUrl: upload.url,
      buffer: params.buffer,
      fileName: params.fileName,
      token: upload.token,
      signal: params.signal,
    });
    return {
      type: params.type,
      payload: { token: upload.token },
    } as MaxAttachmentRequest;
  }

  const result = await uploadMaxMultipart({
    uploadUrl: upload.url,
    buffer: params.buffer,
    fileName: params.fileName,
    signal: params.signal,
  });

  if (params.type === "image") {
    const photos =
      result.photos && typeof result.photos === "object"
        ? (result.photos as Record<string, { token: string }>)
        : undefined;
    if (photos && Object.keys(photos).length > 0) {
      return {
        type: "image",
        payload: { photos },
      };
    }
  }

  const token =
    typeof result.token === "string" ? result.token : upload.token;
  if (!token) {
    throw new Error(`MAX upload did not return a usable token for ${params.type}`);
  }
  return {
    type: params.type,
    payload: { token },
  } as MaxAttachmentRequest;
}

export async function sendMaxAttachmentMessage(params: MaxApiRequestOptions &
  MaxSendTarget & {
    attachment: MaxAttachmentRequest;
    text?: string;
    format?: MaxTextFormat;
  }): Promise<{ messageId?: string; chatId?: string; userId?: string }> {
  return await sendMaxMessage({
    token: params.token,
    apiBaseUrl: params.apiBaseUrl,
    ...resolveSendTarget(params),
    text: params.text,
    format: params.text ? (params.format ?? "markdown") : undefined,
    attachments: [params.attachment],
    signal: params.signal,
  });
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
