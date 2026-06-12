import type { ChatMessage, ChatResponse, ToolDefinitionForModel } from "@seekforge/shared";

export type ProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  /** "deepseek-v4-flash" | "deepseek-v4-pro" (legacy: deepseek-chat/reasoner). */
  model?: string;
  /**
   * DeepSeek V4 thinking mode. true/false sends thinking.type
   * enabled/disabled; unset sends nothing (API default). Only attached for
   * deepseek-v4-* models — legacy models reject the parameter.
   */
  thinking?: boolean;
  /** V4 reasoning effort ("low"/"medium" map to "high" server-side). */
  reasoningEffort?: "high" | "max";
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinitionForModel[];
  temperature?: number;
  maxTokens?: number;
};

export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(
    req: ChatRequest,
    onDelta: (chunk: string) => void,
    /** Streamed chain-of-thought deltas (V4 thinking mode), kept separate from content. */
    onReasoningDelta?: (chunk: string) => void,
  ): Promise<ChatResponse>;
  readonly model: string;
}
