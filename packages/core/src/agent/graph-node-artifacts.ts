import { constants, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { isRecord } from "../util/guards.js";
import { MAX_GRAPH_ARTIFACT_BYTES, storeEngineeringGraphArtifact } from "./graph-artifact-store.js";
import type { GraphFunctionResult } from "./graph-execution-contract.js";
import { GraphNodeNonRetryableError } from "./graph-execution-errors.js";
import type { GraphArtifact } from "./graph-state.js";
import { isSafeLoopDagRelativePath } from "./loop-dag-validation.js";
import { isDenseArray } from "./orchestration.js";

/**
 * Turns handler-declared artifacts into verified, content-addressed evidence.
 * A handler is untrusted input here: paths must stay inside the physical
 * workspace, and the file identity is re-checked before, during, and after
 * hashing so a swapped file cannot be attested.
 */
export async function captureGraphArtifacts(
  value: GraphFunctionResult["artifacts"],
  graphId: string,
  graphFingerprint: string,
  nodeId: string,
  workspace: string,
  verify: boolean,
  artifactStoreWorkspace: string,
): Promise<GraphArtifact[] | undefined> {
  if (value === undefined) return undefined;
  if (
    !isDenseArray(value) ||
    value.length > 32 ||
    value.some(
      (artifact) =>
        !isRecord(artifact) ||
        typeof artifact.name !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(artifact.name) ||
        !isSafeLoopDagRelativePath(artifact.path) ||
        (artifact.sha256 !== undefined &&
          (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256))),
    )
  ) {
    throw new GraphNodeNonRetryableError(`Graph function ${nodeId} returned invalid artifacts`);
  }
  const root = realpathSync.native(workspace);
  return Promise.all(
    value.map(async (artifact): Promise<GraphArtifact> => {
      const base: GraphArtifact = { ...artifact, producerNodeId: nodeId, verified: false };
      if (!verify) return base;
      const target = resolve(root, artifact.path);
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new GraphNodeNonRetryableError(`Graph artifact is not a physical file: ${artifact.path}`);
      }
      const physical = realpathSync.native(target);
      if (physical !== root && !physical.startsWith(`${root}${sep}`)) {
        throw new GraphNodeNonRetryableError(`Graph artifact escapes its workspace: ${artifact.path}`);
      }
      const hash = createHash("sha256");
      let verifiedSize = 0;
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        const current = lstatSync(target);
        if (
          !opened.isFile() ||
          opened.size > MAX_GRAPH_ARTIFACT_BYTES ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          realpathSync.native(target) !== physical
        ) {
          throw new GraphNodeNonRetryableError(`Graph artifact changed during verification: ${artifact.path}`);
        }
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        const after = await handle.stat();
        const finalPath = lstatSync(target);
        if (
          after.size !== opened.size ||
          position !== opened.size ||
          finalPath.dev !== opened.dev ||
          finalPath.ino !== opened.ino ||
          realpathSync.native(target) !== physical
        ) {
          throw new GraphNodeNonRetryableError(`Graph artifact changed during hashing: ${artifact.path}`);
        }
        verifiedSize = opened.size;
      } finally {
        await handle.close();
      }
      const sha256 = hash.digest("hex");
      if (artifact.sha256 && artifact.sha256 !== sha256) {
        throw new GraphNodeNonRetryableError(`Graph artifact hash mismatch: ${artifact.path}`);
      }
      storeEngineeringGraphArtifact(artifactStoreWorkspace, target, sha256, verifiedSize, {
        graphId,
        graphFingerprint,
        producerNodeId: nodeId,
        sourcePath: artifact.path,
      });
      return { ...base, sha256, sizeBytes: verifiedSize, verified: true };
    }),
  );
}
