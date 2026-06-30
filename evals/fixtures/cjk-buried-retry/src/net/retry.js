// Calls `fn` until it returns a truthy value, retrying up to `times` times.
// BUG: an off-by-one in the loop bound — with times=3 it only calls fn 2 extra
// times after the first failure (it should attempt the call `times` times total
// before giving up). The boundary `i < times - 1` drops the last attempt.
export function retry(fn, times) {
  let attempts = 0;
  for (let i = 0; i < times - 1; i++) {
    attempts++;
    const result = fn(attempts);
    if (result) return { ok: true, attempts };
  }
  return { ok: false, attempts };
}
