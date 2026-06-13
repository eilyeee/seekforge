import { MODEL_PRICING, DEFAULT_MODEL, DEPRECATED_MODELS } from "@seekforge/core";
import { green, dim } from "../colors.js";

export function modelsCommand(): void {
  const deprecatedSet = new Set<string>(DEPRECATED_MODELS);
  const entries = Object.entries(MODEL_PRICING);
  const maxIdLen = Math.max(...entries.map(([id]) => id.length));

  // Sort: active (non-deprecated) models first, then deprecated ones.
  entries.sort(([a], [b]) => {
    const aDep = deprecatedSet.has(a) ? 1 : 0;
    const bDep = deprecatedSet.has(b) ? 1 : 0;
    return aDep - bDep;
  });

  console.log("Models available from DeepSeek:\n");

  for (const [id, pricing] of entries) {
    const isDefault = id === DEFAULT_MODEL;
    const isDeprecated = deprecatedSet.has(id);
    const padded = id.padEnd(maxIdLen);
    const depTag = isDeprecated ? `  ${dim("(deprecated)")}` : "";
    const defaultTag = isDefault ? `  ${green("(default)")}` : "";
    console.log(
      `  ${padded}  input: $${pricing.inputCacheMissPer1M}/1M  ` +
        `${dim(`($${pricing.inputCacheHitPer1M} cache-hit/1M)`)}  ` +
        `output: $${pricing.outputPer1M}/1M${depTag}${defaultTag}`,
    );
  }

  console.log(
    `\n${dim("Prices shown are in USD per 1 million tokens. Cache-hit pricing applies when the input prompt prefix is cached.")}`,
  );
}
