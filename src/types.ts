export interface DeploymentSettings {
  id: string;
  displayName: string;
  deploymentName: string;
}

export type ProviderId =
  | "azure-foundry"
  | "deepseek"
  | "anthropic"
  | "openai"
  | "grok"
  | "gemini"
  | "openrouter";

export interface ProviderConnection {
  id: ProviderId;
  endpoint: string;
  apiKeySecretId: string;
}

export interface ModelProfile {
  id: string;
  connectionId: ProviderId;
  displayName: string;
  modelId: string;
  supportsImages?: boolean;
}

export interface NotalithSettings {
  connections: ProviderConnection[];
  models: ModelProfile[];
  activeModelId: string;
  systemPrompt: string;
  includeEmbeddedImages: boolean;
  maxNoteCharacters: number;
  maxToolRounds: number;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  status?: "streaming" | "complete" | "error";
}

export type ContextAttachment =
  | {
      id: string;
      kind: "note";
      path: string;
      name: string;
    }
  | {
      id: string;
      kind: "image";
      path: string;
      name: string;
      mimeType: string;
      data: string;
    }
  | {
      id: string;
      kind: "selection";
      path: string;
      name: string;
      text: string;
    }
  | {
      id: string;
      kind: "document";
      path: string;
      name: string;
    };

export interface ModelImage {
  mimeType: string;
  data: string;
  sourcePath: string;
}

export interface ModelTurnInput {
  text: string;
  images: ModelImage[];
}

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export type ToolOutput = string | Array<Record<string, unknown>>;

export type ProviderInput =
  | { kind: "message"; message: ModelTurnInput }
  | {
      kind: "tool-results";
      results: Array<{ callId: string; output: ToolOutput }>;
    };

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderHandlers {
  onTextDelta(delta: string): void;
  onToolCall(call: ToolCall): void;
  onUsage(usage: ProviderUsage): void;
}

export interface ProviderResult {
  toolCalls: ToolCall[];
  usage?: ProviderUsage;
}

export interface NoteContext {
  path: string;
  content: string;
  images: ModelImage[];
  truncated: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export class NotalithError extends Error {
  constructor(
    message: string,
    readonly category:
      | "authentication"
      | "authorization"
      | "configuration"
      | "rate_limit"
      | "quota"
      | "content_filter"
      | "context_length"
      | "network"
      | "cancelled"
      | "provider"
      | "tool",
    readonly status?: number,
  ) {
    super(message);
    this.name = "NotalithError";
  }
}
