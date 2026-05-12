import { mapValues, fromEntries, type Dict } from "./store.js";

const prices: Dict<number> = fromEntries([
  ["apple", 100],
  ["pear", 250],
]);

// We map number values to formatted string labels. With the buggy signature
// of mapValues (mapper typed `(value: U) => U`), `value` is inferred as
// `string` while the input values are numbers, so `value.toFixed` errors and
// the result type is wrong. After the fix, `value` should be `number` here
// and `labels` should be `Dict<string>`.
const labels: Dict<string> = mapValues(prices, (value) => `$${(value / 100).toFixed(2)}`);

export function allLabels(): string[] {
  return Object.values(labels);
}
