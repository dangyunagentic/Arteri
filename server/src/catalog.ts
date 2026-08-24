// Provider catalog — 9Router-style registry of well-known upstreams.
// Each entry knows how to: build auth headers, fetch its live model list,
// and (optionally) read quota/usage from a usage API.
export type Protocol = "openai" | "anthropic";

export interface OAuthCfg {
  clientId?: string;
  clientSecretEnv?: string; // gemini-style public client secret
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  codeChallengeMethod?: "S256" | "plain";
  extraParams?: Record<string, string>;
  refreshEncoding?: "form" | "json";
}

export interface CatalogEntry {
  id: string;
  name: string;
  protocol: Protocol;
  wire?: "chat" | "responses" | "claude";    // upstream API shape (default chat)
  baseUrl: string;                            // includes version path where needed
  category: "key" | "free" | "cloud" | "oauth";
  auth?: "bearer" | "x-api-key";              // default bearer
  extraHeaders?: Record<string, string>;
  modelsUrl?: string;                         // GET -> { data: [{id}] } or [{id}]
  modelsAuth?: boolean;                       // send auth on models fetch
  modelsPicker?:
    | "openai"
    | "openrouter"
    | "opencode"
    | "gemini"
    | "together"
    | "mistral";
  staticModels?: { id: string; name: string }[]; // oauth providers ship a fixed list
  usageUrl?: string;                          // quota endpoint template
  website?: string;
  notice?: string;
  oauth?: OAuthCfg;
}

const CHAT = "/chat/completions";

export const CATALOG: CatalogEntry[] = [
  // ---- aggregators -------------------------------------------------------
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    category: "key",
    extraHeaders: { "HTTP-Referer": "https://arteri.dev", "X-Title": "Arteri" },
    modelsUrl: "https://openrouter.ai/api/v1/models",
    modelsPicker: "openrouter",             // {data:[{id,name}]} incl :free tags
    website: "https://openrouter.ai/settings/keys",
    notice: "27+ free models with :free suffix. Key at openrouter.ai/settings/keys.",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    category: "key",
    modelsUrl: "https://api.openai.com/v1/models",
    modelsPicker: "openai",
    website: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    category: "key",
    auth: "x-api-key",
    extraHeaders: { "anthropic-version": "2023-06-01" },
    modelsUrl: "https://api.anthropic.com/v1/models?limit=100",
    modelsAuth: true,
    modelsPicker: "openai",                 // same {data:[{id,display_name}]} shape
    website: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    category: "key",
    modelsUrl: "https://api.deepseek.com/models",
    modelsPicker: "openai",
    website: "https://platform.deepseek.com",
  },

  // ---- cheap / fast ------------------------------------------------------
  {
    id: "groq",
    name: "Groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    category: "free",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    modelsPicker: "openai",
    website: "https://console.groq.com/keys",
    notice: "Free tier, generous rate limits.",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    protocol: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    category: "free",
    modelsUrl: "https://api.cerebras.ai/v1/models",
    modelsPicker: "openai",
    website: "https://cloud.cerebras.ai",
  },
  {
    id: "mistral",
    name: "Mistral",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    category: "free",
    modelsUrl: "https://api.mistral.ai/v1/models",
    modelsPicker: "mistral",                // bare array [{id,...}]
    website: "https://console.mistral.ai/api-keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    category: "free",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    modelsPicker: "gemini",                 // {models:[{name:"models/gemini-..."}]}
    website: "https://aistudio.google.com/apikey",
    notice: "Free tier via AI Studio key.",
  },
  {
    id: "glm",
    name: "GLM (Z.ai)",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    category: "key",
    modelsUrl: "https://api.z.ai/api/paas/v4/models",
    modelsPicker: "openai",
    website: "https://z.ai",
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    category: "key",
    modelsUrl: "https://api.moonshot.ai/v1/models",
    modelsPicker: "openai",
    website: "https://platform.moonshot.ai",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    protocol: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    category: "free",
    modelsUrl: "https://integrate.api.nvidia.com/v1/models",
    modelsPicker: "openai",
    website: "https://build.nvidia.com",
  },
  {
    id: "together",
    name: "Together AI",
    protocol: "openai",
    baseUrl: "https://api.together.xyz/v1",
    category: "key",
    modelsUrl: "https://api.together.xyz/v1/models",
    modelsPicker: "together",               // bare array but big; filter chat
    website: "https://api.together.xyz/settings/api-keys",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    category: "key",
    modelsUrl: "https://api.fireworks.ai/inference/v1/models",
    modelsPicker: "openai",
    website: "https://fireworks.ai",
  },
  {
    id: "xai",
    name: "xAI Grok",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    category: "key",
    modelsUrl: "https://api.x.ai/v1/models",
    modelsPicker: "openai",
    website: "https://console.x.ai",
  },
];

export function catalogGet(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.id === id);
}

// ---- OAuth providers (subscription accounts) --------------------------------

const CODEX_MODELS = [
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
  { id: "gpt-5", name: "GPT-5" },
  { id: "codex-mini-latest", name: "Codex Mini" },
];

const CLAUDE_MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
];

export const OAUTH_CATALOG: CatalogEntry[] = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    protocol: "openai",
    wire: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    category: "oauth",
    extraHeaders: { originator: "codex_cli_rs", "User-Agent": "codex_cli_rs/0.136.0" },
    staticModels: CODEX_MODELS,
    usageUrl: "https://chatgpt.com/backend-api/wham/usage",
    website: "https://chatgpt.com/codex",
    notice:
      "Uses your ChatGPT Plus/Pro subscription via the Codex CLI OAuth app. Interactive login or paste token JSON from ~/.codex/auth.json.",
    oauth: {
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      scopes: ["openid", "profile", "email", "offline_access"],
      codeChallengeMethod: "S256",
      extraParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      },
      refreshEncoding: "form",
    },
  },
  {
    id: "claude-code",
    name: "Claude Code",
    protocol: "anthropic",
    wire: "claude",
    baseUrl: "https://api.anthropic.com/v1",
    category: "oauth",
    auth: "x-api-key",
    staticModels: CLAUDE_MODELS,
    usageUrl: "https://api.anthropic.com/api/oauth/usage",
    website: "https://claude.ai/settings/billing",
    notice:
      "Uses your Claude Pro/Max subscription via the Claude Code OAuth client. Bearer-token auth with tool cloaking, like the CLI.",
    oauth: {
      clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://api.anthropic.com/v1/oauth/token",
      scopes: ["org:create_api_key", "user:profile", "user:inference"],
      codeChallengeMethod: "S256",
      refreshEncoding: "json",
    },
  },
];

// merged view for lookups
export const FULL_CATALOG: CatalogEntry[] = [...CATALOG, ...OAUTH_CATALOG];
export function catalogAny(id: string): CatalogEntry | undefined {
  return FULL_CATALOG.find((c) => c.id === id);
}
