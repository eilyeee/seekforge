import { MODEL_PRICING, DEFAULT_MODEL } from "@seekforge/core";
import { green, dim } from "../colors.js";

export function modelsCommand(): void {
  const entries = Object.entries(MODEL_PRICING);
  const maxIdLen = Math.max(...entries.map(([id]) => id.length));

  console.log("Models available from DeepSeek:\n");

  for (const [id, pricing] of entries) {
    const isDefault = id === DEFAULT_MODEL;
    const padded = id.padEnd(maxIdLen);
    const defaultTag = isDefault ? `  ${green("(default)")}` : "";
    console.log(
      `  ${padded}  input: $${pricing.inputCacheMissPer1M}/1M  ` +
        `${dim(`($${pricing.inputCacheHitPer1M} cache-hit/1M)`)}  ` +
        `output: $${pricing.outputPer1M}/1M${defaultTag}`,
    );
  }

  console.log(
    `\n${dim("Prices shown are in USD per 1 million tokens. Cache-hit pricing applies when the input prompt prefix is cached.")}`,
  );
}
