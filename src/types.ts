export const DEFAULT_ACCOUNT_ID = "default";

export type MaxAccountConfig = {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  tokenFile?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  webhookHost?: string;
  webhookPort?: number;
  apiBaseUrl?: string;
  allowFrom?: Array<string | number>;
};

export type MaxChannelConfig = MaxAccountConfig & {
  accounts?: Record<string, MaxAccountConfig>;
};

export type ResolvedMaxAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: "config" | "file" | "none";
  config: MaxAccountConfig;
};

export type MaxWebhookEvent = {
  update_type?: string;
  chat_id?: string | number;
  user_id?: string | number;
  message?: {
    message_id?: string | number;
    id?: string | number;
    sender?: {
      user_id?: string | number;
      username?: string | null;
      first_name?: string | null;
      last_name?: string | null;
      name?: string | null;
      is_bot?: boolean;
    };
    recipient?: {
      chat_id?: string | number;
      user_id?: string | number;
    };
    timestamp?: number;
    body?: {
      text?: string | null;
    };
    text?: string;
  };
  user?: {
    user_id?: string | number;
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    name?: string | null;
    is_bot?: boolean;
  };
  timestamp?: number;
  [key: string]: unknown;
};

export type MaxApiRequestOptions = {
  token: string;
  apiBaseUrl?: string;
  signal?: AbortSignal;
};
