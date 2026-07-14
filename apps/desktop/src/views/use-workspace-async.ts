import { useEffect, useRef } from "react";
import { WorkspaceAsyncCoordinator } from "./async-coordination";

export function useWorkspaceAsyncCoordinator<WorkspaceId>(
  workspaceId: WorkspaceId,
  getActiveWorkspaceId: () => WorkspaceId,
): WorkspaceAsyncCoordinator<WorkspaceId> {
  const coordinator = useRef<WorkspaceAsyncCoordinator<WorkspaceId> | null>(null);
  if (coordinator.current === null) {
    coordinator.current = new WorkspaceAsyncCoordinator(workspaceId, getActiveWorkspaceId);
  }
  coordinator.current.setWorkspace(workspaceId);

  useEffect(() => {
    const current = coordinator.current;
    return () => current?.invalidate();
  }, []);

  return coordinator.current;
}
