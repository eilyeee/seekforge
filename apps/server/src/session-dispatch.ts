/**
 * Session-scoped subagent managers for WS runs.
 *
 * Core keeps a background dispatch alive after the run that started it only
 * when the host passes the same `createDispatchManager({ sessionScoped: true })`
 * to every run of a session (see docs/subagents.md). The Desktop drives one
 * session per tab over one socket, but a socket is not a session: it
 * reconnects, and a session can be resumed from another tab. So managers are
 * keyed by (workspace, session id), owned by the server, and disposed when the
 * session is deleted or the server shuts down.
 *
 * A background dispatch still running when its run ends keeps using that run's
 * tools — its MCP connections and runtime backend. The run's resources are
 * therefore released only once no dispatch of the session is running any more.
 */

import { createDispatchManager, type DispatchManager } from "@seekforge/core";

/** Sessions kept (with their undelivered background results) before the least recently used idle one is dropped. */
export const MAX_IDLE_SESSION_MANAGERS = 64;
/** How often a session with deferred resources checks whether its dispatches settled. */
export const DEFERRED_DISPOSE_POLL_MS = 500;

type Entry = {
  manager: DispatchManager;
  /** Runs of this session currently using the manager. */
  runs: number;
  /** Resources of ended runs whose background dispatches may still use them. */
  disposers: Array<() => void>;
  timer?: NodeJS.Timeout;
};

function hasRunning(manager: DispatchManager): boolean {
  return manager.list().some((dispatch) => dispatch.status === "running");
}

function runAll(disposers: Array<() => void>): void {
  for (const release of disposers.splice(0)) {
    try {
      release();
    } catch {
      // Best effort: one failing release must not keep the others alive.
    }
  }
}

function key(workspace: string, sessionId: string): string {
  return `${workspace}\0${sessionId}`;
}

function disposeEntry(entry: Entry): void {
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = undefined;
  entry.manager.disposeAll();
  runAll(entry.disposers);
}

export class SessionDispatchRegistry {
  /** Insertion order doubles as least-recently-used order (entries are re-inserted on use). */
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(
    private readonly maxIdle = MAX_IDLE_SESSION_MANAGERS,
    private readonly pollMs = DEFERRED_DISPOSE_POLL_MS,
  ) {}

  /** A manager not yet bound to a session (a new session's first run); bind it with `attach`. */
  create(): DispatchManager {
    return createDispatchManager({ sessionScoped: true });
  }

  /**
   * A run of `sessionId` starts using the session's manager: the existing one,
   * else `candidate` (a manager the run created before its session id was
   * known), else a new one. The caller must use the returned manager and call
   * `release` with the same session id when the run ends.
   */
  attach(workspace: string, sessionId: string, candidate?: DispatchManager): DispatchManager {
    const id = key(workspace, sessionId);
    let entry = this.entries.get(id);
    if (entry) this.entries.delete(id);
    else entry = { manager: candidate ?? this.create(), runs: 0, disposers: [] };
    entry.runs++;
    this.entries.set(id, entry);
    this.evict();
    return entry.manager;
  }

  get(workspace: string, sessionId: string): DispatchManager | undefined {
    return this.entries.get(key(workspace, sessionId))?.manager;
  }

  /**
   * A run ended. Its resources are released now, or — while a dispatch of the
   * session is still running — once none is. Without a session (the run failed
   * before one existed) there is nothing to wait for.
   */
  release(workspace: string, sessionId: string | undefined, dispose: () => void): void {
    const entry = sessionId !== undefined ? this.entries.get(key(workspace, sessionId)) : undefined;
    if (entry && entry.runs > 0) entry.runs--;
    if (this.closed || !entry || !hasRunning(entry.manager)) {
      runAll([dispose]);
      return;
    }
    entry.disposers.push(dispose);
    if (entry.timer) return;
    const timer = setInterval(() => {
      if (hasRunning(entry.manager)) return;
      clearInterval(timer);
      entry.timer = undefined;
      runAll(entry.disposers);
    }, this.pollMs);
    timer.unref();
    entry.timer = timer;
  }

  /** The session is gone: cancel its dispatches and release what they held. */
  close(workspace: string, sessionId: string): void {
    const id = key(workspace, sessionId);
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    disposeEntry(entry);
  }

  /** Server shutdown: every dispatch is cancelled and every deferred resource released. */
  disposeAll(): void {
    this.closed = true;
    for (const entry of this.entries.values()) disposeEntry(entry);
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drops least recently used sessions beyond the cap that nothing is using. */
  private evict(): void {
    let excess = this.entries.size - this.maxIdle;
    for (const [id, entry] of this.entries) {
      if (excess <= 0) return;
      if (entry.runs > 0 || entry.disposers.length > 0 || hasRunning(entry.manager)) continue;
      this.entries.delete(id);
      disposeEntry(entry);
      excess--;
    }
  }
}
