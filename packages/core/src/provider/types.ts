import type { ChatMessage, ChatResponse, ToolDefinitionForModel } from "@seekforge/shared";

export type ProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  /** "deepseek-chat" | "deepseek-reasoner" */
  model?: string;
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinitionForModel[];
  temperature?: number;
  maxTokens?: number;
};

export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest, onDelta: (chunk: string) => void): Promise<ChatResponse>;
  readonly model: string;
}
