import type {
  ConnectionTestResult,
  ProviderHandlers,
  ProviderInput,
  ProviderResult,
  ToolDefinition,
} from "../types";

export interface ModelProvider {
  readonly supportsImages: boolean;
  readonly supportsImageToolResults: boolean;
  resetConversation(): void;
  finishTurn(): void;
  abortTurn(): void;
  testConnection(): Promise<ConnectionTestResult>;
  respond(
    input: ProviderInput,
    tools: ToolDefinition[],
    handlers: ProviderHandlers,
    signal: AbortSignal,
  ): Promise<ProviderResult>;
}
