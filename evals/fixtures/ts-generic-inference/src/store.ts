/**
 * A tiny typed key/value store.
 *
 * There is a generics bug here: `mapValues` claims to return Record<K, U>
 * but the mapper is typed to receive the wrong element type, so callers in
 * app.ts that rely on inference get a type error. Fix the generic signatures
 * so inference flows correctly. Do NOT change the runtime behavior.
 */
export type Dict<V> = Record<string, V>;

/** Apply `fn` to every value, preserving keys. */
export function mapValues<V, U>(dict: Dict<V>, fn: (value: U) => U): Dict<U> {
  const out: Dict<U> = {};
  for (const key of Object.keys(dict)) {
    out[key] = fn(dict[key] as unknown as U);
  }
  return out;
}

/** Build a Dict from entries. */
export function fromEntries<V>(entries: Array<[string, V]>): Dict<V> {
  const out: Dict<V> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}
