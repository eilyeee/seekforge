/** Secret redaction for command outputs. Keeps the first 4 chars + "****". */

import { isSecretEnvName } from "../util/scrub-env.js";

function mask(value: string): string {
  return value.slice(0, 4) + "****";
}

/** PEM private key blocks — body is fully replaced. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** Well-known token prefixes. */
const TOKEN_PREFIXES =
  /\b((?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[bpasr]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{8,}|AIza[A-Za-z0-9_-]{8,})/g;

/** Uppercase env-style assignments; names are classified by the shared scrub policy. */
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*)(\s*[=:]\s*)("([^"\n]+)"|'([^'\n]+)'|(\S+))/g;

/** Generic key/token/secret/password assignments with 20+ char mixed-charset values. */
const GENERIC_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:key|token|secret|password)[A-Za-z0-9_-]*)(\s*[=:]\s*)("([^"\n]{20,})"|'([^'\n]{20,})'|([A-Za-z0-9+/_=-]{20,}))/gi;

function isMixedCharset(value: string): boolean {
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  return classes >= 2;
}

export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK, (block) => {
    const lines = block.split("\n");
    const header = lines[0] ?? "";
    const footer = lines[lines.length - 1] ?? "";
    return `${header}\n****\n${footer}`;
  });

  out = out.replace(TOKEN_PREFIXES, (m) => mask(m));

  out = out.replace(ENV_ASSIGNMENT, (match, name: string, sep: string, quoted: string) => {
    if (!isSecretEnvName(name)) return match;
    const value = quoted.replace(/^["']|["']$/g, "");
    if (value.includes("****")) return `${name}${sep}${quoted}`;
    const q = quoted.startsWith('"') ? '"' : quoted.startsWith("'") ? "'" : "";
    return `${name}${sep}${q}${mask(value)}${q}`;
  });

  out = out.replace(GENERIC_ASSIGNMENT, (m, name: string, sep: string, quoted: string) => {
    const value = quoted.replace(/^["']|["']$/g, "");
    if (value.includes("****") || !isMixedCharset(value)) return m;
    const q = quoted.startsWith('"') ? '"' : quoted.startsWith("'") ? "'" : "";
    return `${name}${sep}${q}${mask(value)}${q}`;
  });

  return out;
}
