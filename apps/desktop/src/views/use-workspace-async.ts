import { useEffect, useMemo, useRef } from "react";
import { WorkspaceAsyncCoordinator } from "./async-coordination";

export function useWorkspaceAsyncCoordinator<WorkspaceId>(
  workspaceId: WorkspaceId,
  getActiveWorkspaceId: () => WorkspaceId,
): WorkspaceAsyncCoordinator<WorkspaceId> {
  const activeWorkspaceRef = useRef(getActiveWorkspaceId);
  activeWorkspaceRef.current = getActiveWorkspaceId;
  const coordinator = useMemo(
    () => new WorkspaceAsyncCoordinator(workspaceId, () => activeWorkspaceRef.current()),
    [workspaceId],
  );

  useEffect(() => {
    return () => coordinator.invalidate();
  }, [coordinator]);

  return coordinator;
}
