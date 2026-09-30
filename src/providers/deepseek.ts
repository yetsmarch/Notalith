import type { ModelProfile, ProviderConnection } from "../types";
import { ChatCompletionsProvider } from "./chat-completions";

export class DeepSeekProvider extends ChatCompletionsProvider {
  constructor(
    connection: ProviderConnection,
    model: ModelProfile,
    systemPrompt: string,
    getApiKey: () => string | null,
  ) {
    super(connection, model, systemPrompt, getApiKey, {
      name: "DeepSeek",
      supportsImages: model.modelId === "deepseek-flash",
      preserveReasoning: true,
    });
  }
}
