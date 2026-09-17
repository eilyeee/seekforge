/**
 * Classifies what the plugin install box holds, only to decide whether to ask
 * before installing. Core classifies the source for real (and rejects what it
 * cannot use); a remote source downloads code, so the UI confirms it first.
 */

/**
 * True for a source that fetches code from elsewhere: a URL (`https://…`,
 * `ssh://…`, `git+…`), an scp-style git remote (`git@host:org/repo`), or a
 * `<plugin>@<marketplace>` reference. Local paths (absolute, relative, `~`)
 * are not remote.
 */
export function isRemotePluginSource(source: string): boolean {
  const value = source.trim();
  if (value === "") return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^git\+/i.test(value) || /^[\w.-]+@[\w.-]+:/.test(value)) return true;
  // `<plugin>@<marketplace>`: no path separator, one "@" between two names.
  return !/[\\/]/.test(value) && /^[\w.-]+@[\w.-]+$/.test(value);
}
