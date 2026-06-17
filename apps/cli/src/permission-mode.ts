/**
 * Pure mapping from the CLI's permission flags onto the core ApprovalMode
 * (+ a plan-first flag). Extracted from run.ts so the mapping is unit-testable
 * without spinning up an agent.
 *
 * Precedence: --permission-mode (when set) wins over -y /
 * --dangerously-skip-permissions. With no --permission-mode, either of those
 * flags → "auto", otherwise "confirm".
 *
 * Claude-compatible names map onto ApprovalMode (native names also accepted):
 *   default            → confirm
 *   confirm  (native)  → confirm
 *   acceptEdits        → acceptEdits
 *   bypassPermissions  → auto
 *   auto     (native)  → auto
 *   plan               → confirm  (and forces plan-first)
 */
import type { ApprovalMode } from "@seekforge/shared";

export type PermissionFlags = {
  /** -y */
  yes?: boolean;
  /** --dangerously-skip-permissions */
  dangerouslySkipPermissions?: boolean;
  /** --permission-mode <name> (overrides the two flags above when set) */
  permissionMode?: string;
};

export type ResolvedPermission = {
  approvalMode: ApprovalMode;
  /** True when --permission-mode plan was given (plan-first execution). */
  planFromMode: boolean;
};

/** Thrown for an unrecognized --permission-mode value (run.ts turns it into a fail()). */
export class UnknownPermissionModeError extends Error {
  constructor(public readonly mode: string) {
    super(`unknown permission mode: ${mode}`);
    this.name = "UnknownPermissionModeError";
  }
}

/**
 * Resolves the effective ApprovalMode from the permission flags. Pure: no I/O,
 * no process state. Throws UnknownPermissionModeError on an unknown mode name.
 */
export function resolvePermissionMode(flags: PermissionFlags): ResolvedPermission {
  // Base from the boolean flags; --permission-mode overrides below when set.
  let approvalMode: ApprovalMode = flags.yes || flags.dangerouslySkipPermissions ? "auto" : "confirm";
  let planFromMode = false;

  if (flags.permissionMode) {
    switch (flags.permissionMode) {
      case "default":
      case "confirm":
        approvalMode = "confirm";
        break;
      case "acceptEdits":
        approvalMode = "acceptEdits";
        break;
      case "bypassPermissions":
      case "auto":
        approvalMode = "auto";
        break;
      case "plan":
        approvalMode = "confirm";
        planFromMode = true;
        break;
      default:
        throw new UnknownPermissionModeError(flags.permissionMode);
    }
  }

  return { approvalMode, planFromMode };
}
