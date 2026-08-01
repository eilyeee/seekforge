/** Minimal browser storage contract, kept injectable for deterministic tests. */
export type KVStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};
