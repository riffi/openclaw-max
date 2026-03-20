import type { Server } from "node:http";

type MaxRuntime = {
  note?: string;
  servers?: Map<string, Server>;
  botUsernames?: Map<string, string>;
};

let currentRuntime: MaxRuntime | null = null;

export function setMaxRuntime(runtime: MaxRuntime): void {
  currentRuntime = runtime;
}

export function getMaxRuntime(): MaxRuntime {
  if (!currentRuntime) {
    throw new Error("MAX runtime not initialized");
  }
  return currentRuntime;
}

export function setMaxBotUsername(accountId: string, username: string | undefined): void {
  if (!currentRuntime) {
    return;
  }
  if (!currentRuntime.botUsernames) {
    currentRuntime.botUsernames = new Map();
  }
  if (username?.trim()) {
    currentRuntime.botUsernames.set(accountId, username.trim());
  } else {
    currentRuntime.botUsernames.delete(accountId);
  }
}

export function getMaxBotUsername(accountId: string): string | undefined {
  return currentRuntime?.botUsernames?.get(accountId);
}
