export class LatestRequest {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(request: number): boolean {
    return request === this.generation;
  }
}

/** Per-resource edit revisions for rejecting async results after newer input. */
export class EditRevisions<Key> {
  private readonly revisions = new Map<Key, number>();

  capture(key: Key): number {
    return this.revisions.get(key) ?? 0;
  }

  advance(key: Key): number {
    const revision = this.capture(key) + 1;
    this.revisions.set(key, revision);
    return revision;
  }

  isCurrent(key: Key, revision: number): boolean {
    return this.capture(key) === revision;
  }
}

export interface WorkspaceOperation<WorkspaceId> {
  readonly workspaceId: WorkspaceId;
  readonly workspaceGeneration: number;
  readonly request?: number;
}

export interface WorkspaceValue<WorkspaceId, Value> {
  readonly workspaceId: WorkspaceId;
  readonly value: Value;
}

export function valueForWorkspace<WorkspaceId, Value>(
  state: WorkspaceValue<WorkspaceId, Value>,
  workspaceId: WorkspaceId,
): Value | null {
  return Object.is(state.workspaceId, workspaceId) ? state.value : null;
}

export class WorkspaceAsyncCoordinator<WorkspaceId> {
  private workspaceGeneration = 0;
  private readonly requests = new LatestRequest();

  constructor(
    private workspaceId: WorkspaceId,
    private readonly getActiveWorkspaceId: () => WorkspaceId,
  ) {}

  setWorkspace(workspaceId: WorkspaceId): void {
    if (Object.is(this.workspaceId, workspaceId)) return;
    this.invalidate();
    this.workspaceId = workspaceId;
  }

  capture(workspaceId: WorkspaceId = this.workspaceId): WorkspaceOperation<WorkspaceId> | null {
    if (!Object.is(workspaceId, this.workspaceId) || !Object.is(workspaceId, this.getActiveWorkspaceId())) {
      return null;
    }
    return { workspaceId, workspaceGeneration: this.workspaceGeneration };
  }

  beginLatest(workspaceId: WorkspaceId = this.workspaceId): WorkspaceOperation<WorkspaceId> | null {
    const operation = this.capture(workspaceId);
    if (!operation) return null;
    return { ...operation, request: this.requests.begin() };
  }

  invalidate(): void {
    this.workspaceGeneration += 1;
    this.requests.invalidate();
  }

  isCurrent(operation: WorkspaceOperation<WorkspaceId>): boolean {
    return (
      operation.workspaceGeneration === this.workspaceGeneration &&
      Object.is(operation.workspaceId, this.workspaceId) &&
      Object.is(operation.workspaceId, this.getActiveWorkspaceId()) &&
      (operation.request === undefined || this.requests.isCurrent(operation.request))
    );
  }
}

export class ExclusiveOperation {
  private current: symbol | null = null;

  begin(): symbol | null {
    if (this.current !== null) return null;
    this.current = Symbol("exclusive-operation");
    return this.current;
  }

  end(operation: symbol): boolean {
    if (this.current !== operation) return false;
    this.current = null;
    return true;
  }

  invalidate(): void {
    this.current = null;
  }
}

export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}
