import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  type MaxAccountConfig,
  type MaxChannelConfig,
  type ResolvedMaxAccount,
} from "./types.js";

export function readChannelConfig(cfg: OpenClawConfig): MaxChannelConfig {
  const raw = (cfg.channels as Record<string, unknown> | undefined)?.max;
  return (raw ?? {}) as MaxChannelConfig;
}

export function readAccountConfig(cfg: OpenClawConfig, accountId?: string | null): MaxAccountConfig {
  const channel = readChannelConfig(cfg);
  const resolvedAccountId = (accountId?.trim() || DEFAULT_ACCOUNT_ID).trim();
  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    return channel;
  }
  return channel.accounts?.[resolvedAccountId] ?? {};
}

function readTokenFile(tokenFile: string): string {
  return fs.readFileSync(tokenFile, "utf8").trim();
}

export function resolveToken(config: MaxAccountConfig): {
  token: string;
  tokenSource: "config" | "file" | "none";
} {
  const inlineToken = config.botToken?.trim();
  if (inlineToken) {
    return {
      token: inlineToken,
      tokenSource: "config",
    };
  }

  const tokenFile = config.tokenFile?.trim();
  if (tokenFile) {
    const fileToken = readTokenFile(tokenFile);
    return {
      token: fileToken,
      tokenSource: "file",
    };
  }

  return {
    token: "",
    tokenSource: "none",
  };
}

export function listMaxAccountIds(cfg: OpenClawConfig): string[] {
  const channel = readChannelConfig(cfg);
  const accountIds = Object.keys(channel.accounts ?? {});
  return [DEFAULT_ACCOUNT_ID, ...accountIds];
}

export function resolveMaxAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedMaxAccount {
  const resolvedAccountId = (accountId?.trim() || DEFAULT_ACCOUNT_ID).trim();
  const config = readAccountConfig(cfg, resolvedAccountId);
  const token = resolveToken(config);
  return {
    accountId: resolvedAccountId,
    name: config.name,
    enabled: config.enabled !== false,
    token: token.token,
    tokenSource: token.tokenSource,
    config,
  };
}

