export const MaxChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      name: { type: "string" },
      botToken: { type: "string" },
      tokenFile: { type: "string" },
      webhookUrl: { type: "string" },
      webhookSecret: { type: "string" },
      webhookPath: { type: "string" },
      webhookHost: { type: "string" },
      webhookPort: { type: "number" },
      apiBaseUrl: { type: "string" },
      groupRequireMention: { type: "boolean" },
      allowFrom: {
        type: "array",
        items: { type: ["string", "number"] },
      },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            name: { type: "string" },
            botToken: { type: "string" },
            tokenFile: { type: "string" },
            webhookUrl: { type: "string" },
            webhookSecret: { type: "string" },
            webhookPath: { type: "string" },
            webhookHost: { type: "string" },
            webhookPort: { type: "number" },
            apiBaseUrl: { type: "string" },
            groupRequireMention: { type: "boolean" },
            allowFrom: {
              type: "array",
              items: { type: ["string", "number"] },
            },
          },
        },
      },
    },
  },
  uiHints: {
    botToken: {
      label: "Bot Token",
      sensitive: true,
    },
    webhookSecret: {
      label: "Webhook Secret",
      sensitive: true,
    },
    webhookUrl: {
      label: "Webhook URL",
      placeholder: "https://example.com/max/webhook",
    },
    webhookHost: {
      label: "Webhook Host",
      placeholder: "127.0.0.1",
      advanced: true,
    },
    webhookPort: {
      label: "Webhook Port",
      placeholder: "8788",
      advanced: true,
    },
    apiBaseUrl: {
      label: "API Base URL",
      placeholder: "https://platform-api.max.ru",
      advanced: true,
    },
    groupRequireMention: {
      label: "Require mention in groups",
      advanced: true,
    },
  },
} as const;
