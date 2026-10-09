import type {
  ConnectionTestResult,
  ProviderHandlers,
  ProviderInput,
  ProviderResult,
  ToolDefinition,
} from "../types";
import type { ProviderContext } from "../services/context-history";

export interface ProviderRequestOptions {
  maxOutputTokens?: number;
}

export interface ModelProvider {
  readonly context: ProviderContext;
  readonly supportsImages: boolean;
  readonly supportsImageToolResults: boolean;
  createSummaryProvider(systemPrompt: string): ModelProvider;
  onContextReplaced?(): void;
  resetConversation(): void;
  finishTurn(): void;
  abortTurn(): void;
  testConnection(): Promise<ConnectionTestResult>;
  respond(
    input: ProviderInput,
    tools: ToolDefinition[],
    handlers: ProviderHandlers,
    signal: AbortSignal,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResult>;
}
