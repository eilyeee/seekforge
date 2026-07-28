import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveForWrite, resolveInsideWorkspace } from "../tools/sandbox.js";

export const LOOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidLoopId(loopId: string): boolean {
  return LOOP_ID_RE.test(loopId);
}

export function requireLoopWorkspace(workspace: string): string {
  if (!isAbsolute(workspace)) throw new Error("Loop workspace must be an absolute path");
  const absolute = resolve(workspace);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export const loopStateRoot = (workspace: string): string =>
  resolveInsideWorkspace(requireLoopWorkspace(workspace), join(".seekforge", "loops"));

export function loopStateFile(workspace: string, loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return resolveForWrite(requireLoopWorkspace(workspace), join(".seekforge", "loops", `${loopId}.json`));
}

export function loopLogFile(workspace: string, loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return resolveForWrite(requireLoopWorkspace(workspace), join(".seekforge", "loops", `${loopId}.log`));
}

export function loopLockFile(workspace: string, loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return resolveForWrite(requireLoopWorkspace(workspace), join(".seekforge", "loops", `.${loopId}.lock`));
}
