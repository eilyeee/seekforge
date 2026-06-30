// Decoy: a similarly named, CORRECT module. Computes the backoff delay (ms) for
// a given attempt number. This file is fine and must not be edited.
export function retryDelay(attempt) {
  return 100 * 2 ** (attempt - 1);
}
