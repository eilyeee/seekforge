const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s,"']{6,}/gi,
];

export const DEFAULT_SECURITY_TEXT_LIMIT = 8_000;

export function redactSecurityText(value: string, maxChars = DEFAULT_SECURITY_TEXT_LIMIT): string {
  let output = value.replace(/\0/g, "");
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  if (output.length > maxChars) output = `${output.slice(0, maxChars)}\n[TRUNCATED]`;
  return output;
}

export function sanitizeSecurityText(value: string, maxChars = DEFAULT_SECURITY_TEXT_LIMIT): string {
  return redactSecurityText(value.trim(), maxChars);
}
