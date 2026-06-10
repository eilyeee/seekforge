/**
 * Client for the Rust seekforge-runtime (trusted local execution layer).
 * Protocol: crates/runtime/PROTOCOL.md. Permission decisions stay in the
 * TypeScript dispatcher — the runtime is an execution backend with its own
 * defense-in-depth checks, not the policy source.
 */

export { createRuntimeClient, RuntimeError, type RuntimeClient, type RuntimeClientOptions } from "./client.js";
