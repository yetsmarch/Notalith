export interface DeploymentSettings {
  id: string;
  displayName: string;
  deploymentName: string;
}

export interface NotalithSettings {
  azureEndpoint: string;
  deploymentName: string;
  deployments: DeploymentSettings[];
  apiKeySecretId: string;
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
  responseId: string;
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
