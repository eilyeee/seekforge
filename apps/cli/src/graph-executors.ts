/**
 * Host registration of Graph `remote` executors for the CLI.
 *
 * An Engineering Graph's `remote` node delegates to a trusted
 * `GraphExecutionAdapter`, and preflight refuses anything that is not both
 * `trusted` and `locality: "remote"`. Trust therefore has to come from
 * somewhere, and the one place it must NEVER come from is the material a Graph
 * run already reads: the graph definition, a plugin manifest, or a file that
 * arrives with a cloned repository. All three describe work; none of them is the
 * operator.
 *
 * So this file reads exactly one thing: `~/.seekforge/graph-executors.json`, in
 * the user's own home directory. Writing it is the explicit act by which the
 * operator says "this machine may hand agent tasks to that container / that
 * host". Absent the file, no runner adapter exists, `remote` nodes fail
 * preflight with "Executor is not registered", and a hostile repository cannot
 * change that by shipping any file of its own.
 *
 * Plugin manifests keep their existing role: `graphExecutorsWithPlugins` lets a
 * plugin ALIAS an id the host already registered as trusted. It cannot widen
 * trust, and nothing here relaxes that.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  createGraphRemoteRunnerAdapter,
  graphExecutorsWithPlugins,
  isRecord,
  isValidLoopDagId,
  loadPluginContributions,
  type GraphExecutionAdapter,
} from "@seekforge/core";
import { FileTooLargeError, MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";
import { dockerGraphTransport } from "./docker-runner.js";
import { sshGraphTransport } from "./ssh-runner.js";

/** Registration file, read from the operator's home directory only. */
export const GRAPH_EXECUTORS_FILE = join(homedir(), ".seekforge", "graph-executors.json");

const MAX_EXECUTORS = 32;

function optionalString(entry: Record<string, unknown>, key: string, id: string): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`Graph executor ${id}: ${key} must be a non-empty string`);
  }
  return value;
}

function requiredString(entry: Record<string, unknown>, key: string, id: string): string {
  const value = optionalString(entry, key, id);
  if (value === undefined) throw new Error(`Graph executor ${id}: ${key} is required`);
  return value;
}

function boundedInteger(
  entry: Record<string, unknown>,
  key: string,
  id: string,
  min: number,
  max: number,
): number | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Graph executor ${id}: ${key} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function buildAdapter(id: string, entry: Record<string, unknown>): GraphExecutionAdapter {
  const runner = requiredString(entry, "runner", id);
  const capacity = boundedInteger(entry, "capacity", id, 1, 1_024);
  const workspaceCapacity = boundedInteger(entry, "workspaceCapacity", id, 1, 512);
  const adapterOptions = {
    ...(capacity !== undefined ? { capacity } : {}),
    ...(workspaceCapacity !== undefined ? { workspaceCapacity } : {}),
  };
  const optional = (key: string): Record<string, string> => {
    const value = optionalString(entry, key, id);
    return value === undefined ? {} : { [key]: value };
  };
  if (runner === "docker") {
    return createGraphRemoteRunnerAdapter(
      id,
      dockerGraphTransport({
        ...optional("image"),
        ...optional("network"),
        ...optional("memory"),
        ...optional("cpus"),
        ...optional("workdir"),
      }),
      adapterOptions,
    );
  }
  if (runner === "ssh") {
    const port = boundedInteger(entry, "port", id, 1, 65_535);
    return createGraphRemoteRunnerAdapter(
      id,
      sshGraphTransport({
        host: requiredString(entry, "host", id),
        workspacePath: requiredString(entry, "workspace", id),
        ...(port !== undefined ? { port } : {}),
        ...optional("identityFile"),
        ...optional("binary"),
        ...optional("provider"),
        ...optional("model"),
      }),
      adapterOptions,
    );
  }
  throw new Error(`Graph executor ${id}: runner must be docker or ssh`);
}

/**
 * PURE apart from the single home-directory read: parses the registration file
 * into trusted adapters. Throws on a malformed file rather than degrading to an
 * empty registry — an operator who wrote the file meant to register something,
 * and silently running a Graph without it is the wrong kind of quiet.
 */
export function loadRegisteredGraphExecutors(file = GRAPH_EXECUTORS_FILE): Record<string, GraphExecutionAdapter> {
  let raw: string;
  try {
    raw = readTextFileBounded(file, MAX_CONFIG_FILE_BYTES);
  } catch (error) {
    if (error instanceof FileTooLargeError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Graph executor registry is not valid JSON: ${file}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.executors)) {
    throw new Error(`Graph executor registry must be {"version":1,"executors":{…}}: ${file}`);
  }
  const entries = Object.entries(parsed.executors);
  if (entries.length > MAX_EXECUTORS) {
    throw new Error(`Graph executor registry declares more than ${MAX_EXECUTORS} executors: ${file}`);
  }
  const executors: Record<string, GraphExecutionAdapter> = {};
  for (const [id, entry] of entries) {
    if (!isValidLoopDagId(id)) throw new Error(`Graph executor id is invalid: ${id}`);
    if (!isRecord(entry)) throw new Error(`Graph executor ${id} must be an object`);
    executors[id] = buildAdapter(id, entry);
  }
  return executors;
}

/**
 * The executor registry a CLI Graph run should use: host registrations, plus the
 * plugin aliases that point at them. Host registrations win on a name clash, so
 * a plugin can never shadow the adapter the operator actually configured.
 */
export function loadGraphExecutionRegistry(
  workspace: string,
  file = GRAPH_EXECUTORS_FILE,
): Readonly<Record<string, GraphExecutionAdapter>> {
  const registered = loadRegisteredGraphExecutors(file);
  return Object.freeze({
    ...graphExecutorsWithPlugins(loadPluginContributions(workspace), registered),
    ...registered,
  });
}
