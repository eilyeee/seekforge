// Parses an inclusive integer range string "a-b" into [a, b].
// Valid inputs include negative bounds, e.g. "-3-7" -> [-3, 7].
// BUG: returns the two numbers in the wrong order.
export function parseRange(s) {
  const p = s.split("-");
  return [Number(p[1]), Number(p[0])];
}
