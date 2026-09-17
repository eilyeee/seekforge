/**
 * One session-scoped subagent manager per tab.
 *
 * Core keeps a background dispatch (`dispatch_agent` with background:true)
 * alive past the run that started it only when the host passes the same
 * `createDispatchManager({ sessionScoped: true })` to every run of the session;
 * the next run then reports the dispatch's outcome to the model. A tab is the
 * TUI's session, so each tab owns one — like the process-wide background-task
 * manager, but scoped to the conversation the dispatches belong to.
 *
 * When the tab's session ends (a new or resumed session, a detached run, the
 * tab closing), its manager is retired: the tab gets a fresh one for its next
 * run, and the old one is disposed — at once, or when the last run still using
 * it (a detached run) ends. App exit disposes every manager.
 */

import { createDispatchManager, type DispatchManager } from "@seekforge/core";

export type TabDispatchManagers = {
  /** The tab's current manager, created on first use. */
  current(tabId: number): DispatchManager;
  /** The tab's current manager, if it has one. */
  peek(tabId: number): DispatchManager | undefined;
  /** A run starts using `manager`; the returned function (idempotent) ends that use. */
  acquire(manager: DispatchManager): () => void;
  /** The tab's session ended; its manager is disposed once no run uses it. */
  retire(tabId: number): void;
  /** App exit: every manager, in use or not. */
  disposeAll(): void;
};

export function createTabDispatchManagers(
  create: () => DispatchManager = () => createDispatchManager({ sessionScoped: true }),
): TabDispatchManagers {
  const byTab = new Map<number, DispatchManager>();
  const users = new Map<DispatchManager, number>();
  const retired = new Set<DispatchManager>();

  const dispose = (manager: DispatchManager): void => {
    retired.delete(manager);
    users.delete(manager);
    manager.disposeAll();
  };

  return {
    current(tabId) {
      let manager = byTab.get(tabId);
      if (!manager) {
        manager = create();
        byTab.set(tabId, manager);
      }
      return manager;
    },
    peek: (tabId) => byTab.get(tabId),
    acquire(manager) {
      users.set(manager, (users.get(manager) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (users.get(manager) ?? 1) - 1;
        if (left > 0) {
          users.set(manager, left);
          return;
        }
        users.delete(manager);
        if (retired.has(manager)) dispose(manager);
      };
    },
    retire(tabId) {
      const manager = byTab.get(tabId);
      if (!manager) return;
      byTab.delete(tabId);
      if ((users.get(manager) ?? 0) > 0) retired.add(manager);
      else dispose(manager);
    },
    disposeAll() {
      const all = new Set([...byTab.values(), ...retired, ...users.keys()]);
      byTab.clear();
      retired.clear();
      users.clear();
      for (const manager of all) manager.disposeAll();
    },
  };
}
