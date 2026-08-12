/**
 * Core's entry point to the Loop verification-plan contract.
 *
 * The rules themselves live in `@seekforge/shared` and this module only
 * re-exports them. That is deliberate and it is the *only* direction that
 * works: five surfaces need the identical rules, and two of them — the WS
 * `loop` frame decoder and the `ClientFrame` type it decodes into — sit in
 * `packages/shared`, which must never depend on `packages/core`. Hoisting the
 * rules into core would have left those two re-rolling their own copy, which is
 * exactly the drift this contract exists to end. Core keeps this file as its
 * named entry point so the engine and the graph parser go on importing one
 * owner by name.
 *
 * The parser is pure — no filesystem, clock or timer — so both core callers can
 * run the complete check while it is still cheap to fail: `runAutoLoop` must
 * finish validating before it takes a lifecycle lease, resolves providers,
 * persists state or provisions a worktree, and `parseGraphLoopOptions` must
 * reject an unrunnable `loop` node while the graph definition parse is still
 * pure. See the shared module's header for the three parameterised differences
 * (`rejectUnknownFields`, `maxTimeoutMs`, `replayed`) and why each is an
 * argument rather than a fork.
 */

export {
  MAX_LOOP_TIMEOUT_MS,
  MAX_LOOP_VERIFICATION_COMMAND_LENGTH,
  MAX_LOOP_VERIFICATION_PATH_LENGTH,
  MAX_LOOP_VERIFICATION_STAGE_PATHS,
  MAX_LOOP_VERIFICATION_STAGE_RESOURCES,
  MAX_LOOP_VERIFICATION_STAGES,
  parseLoopVerificationPlan,
  type LoopVerificationPlanRules,
} from "@seekforge/shared";
