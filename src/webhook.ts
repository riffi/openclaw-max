import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ChannelLogSink } from "openclaw/plugin-sdk/core";
import type { MaxWebhookEvent, ResolvedMaxAccount } from "./types.js";

const MAX_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;
const MAX_WEBHOOK_REPLAY_MAX_SIZE = 5000;
const recentWebhookEvents = new Map<string, number>();

function headerValue(req: IncomingMessage, key: string): string | undefined {
  const value = req.headers[key];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? (JSON.parse(body) as unknown) : {};
}

function send(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function resolveReplayKey(event: MaxWebhookEvent): string | undefined {
  const updateType = typeof event.update_type === "string" ? event.update_type.trim() : "";
  const messageId = event.message?.message_id ?? event.message?.id;
  if (!updateType || messageId === undefined || messageId === null) {
    return undefined;
  }
  return `${updateType}:${String(messageId)}`;
}

function pruneRecentWebhookEvents(nowMs: number): void {
  const cutoff = nowMs - MAX_WEBHOOK_REPLAY_WINDOW_MS;
  for (const [key, seenAt] of recentWebhookEvents) {
    if (seenAt < cutoff) {
      recentWebhookEvents.delete(key);
    }
  }
  while (recentWebhookEvents.size > MAX_WEBHOOK_REPLAY_MAX_SIZE) {
    const oldestKey = recentWebhookEvents.keys().next().value;
    if (!oldestKey) {
      break;
    }
    recentWebhookEvents.delete(oldestKey);
  }
}

function isReplayEvent(event: MaxWebhookEvent, nowMs: number): boolean {
  pruneRecentWebhookEvents(nowMs);
  const replayKey = resolveReplayKey(event);
  if (!replayKey) {
    return false;
  }
  if (recentWebhookEvents.has(replayKey)) {
    return true;
  }
  recentWebhookEvents.set(replayKey, nowMs);
  return false;
}

export async function startMaxWebhookServer(params: {
  account: ResolvedMaxAccount;
  runtime: RuntimeEnv;
  log?: ChannelLogSink;
  abortSignal: AbortSignal;
  onEvent: (event: MaxWebhookEvent) => Promise<void>;
}): Promise<Server> {
  const host = params.account.config.webhookHost?.trim() || "127.0.0.1";
  const port = params.account.config.webhookPort ?? 8788;
  const path = params.account.config.webhookPath?.trim() || "/max-webhook";
  const secret = params.account.config.webhookSecret?.trim();

  const server = createServer(async (req, res) => {
    if (!req.url) {
      send(res, 404, "not found");
      return;
    }

    if (req.method === "GET" && req.url === "/healthz") {
      send(res, 200, "ok");
      return;
    }

    if (req.method !== "POST" || req.url !== path) {
      send(res, 404, "not found");
      return;
    }

    if (secret) {
      const headerSecret = headerValue(req, "x-max-bot-api-secret");
      if (headerSecret !== secret) {
        send(res, 401, "unauthorized");
        return;
      }
    }

    try {
      const event = (await readJsonBody(req)) as MaxWebhookEvent;
      if (isReplayEvent(event, Date.now())) {
        send(res, 200, "ok");
        return;
      }
      void params.onEvent(event).catch((error) => {
        params.log?.error?.(
          `[${params.account.accountId}] MAX webhook request failed: ${String(error)}`,
        );
      });
      send(res, 200, "ok");
    } catch (error) {
      params.log?.error?.(
        `[${params.account.accountId}] MAX webhook request failed: ${String(error)}`,
      );
      send(res, 400, "bad request");
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.on("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  params.log?.info?.(
    `[${params.account.accountId}] MAX webhook listener started on http://${host}:${String(port)}${path}`,
  );

  const closeServer = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    params.log?.info?.(`[${params.account.accountId}] MAX webhook listener stopped`);
  };

  if (params.abortSignal.aborted) {
    void closeServer();
  } else {
    params.abortSignal.addEventListener(
      "abort",
      () => {
        void closeServer();
      },
      { once: true },
    );
  }

  return server;
}
