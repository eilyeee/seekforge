export function clamp(value, min, max) {
  // TODO(stage-1): values below min must clamp to min.
  if (value < min) return value;
  // TODO(stage-2): values above max must clamp to max.
  if (value > max) return value;
  return value;
}
