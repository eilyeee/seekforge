import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listEngineeringGraphArtifactAttestations,
  storeEngineeringGraphArtifact,
} from "../../src/agent/graph-artifact-store.js";
import {
  registerEngineeringGraphArtifactTrustKey,
  listEngineeringGraphArtifactTrustVerifications,
  revokeEngineeringGraphArtifactTrustKey,
  signEngineeringGraphArtifactAttestation,
  verifyEngineeringGraphArtifactAttestationTrust,
} from "../../src/agent/graph-artifact-trust.js";

describe("Graph artifact trust", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("binds provenance to an Ed25519 key and honors revocation", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-artifact-trust-"));
    roots.push(root);
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "result.txt"), "trusted\n");
    const sha256 = createHash("sha256").update("trusted\n").digest("hex");
    storeEngineeringGraphArtifact(root, join(root, "out", "result.txt"), sha256, 8, {
      graphId: "build",
      graphFingerprint: "a".repeat(64),
      producerNodeId: "compile",
      sourcePath: "out/result.txt",
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    registerEngineeringGraphArtifactTrustKey(
      root,
      "release-2026",
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const attestationId = listEngineeringGraphArtifactAttestations(root)[0]!.id;
    signEngineeringGraphArtifactAttestation(root, attestationId, {
      keyId: "release-2026",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      builderId: "ci-builder",
      environmentSha256: "b".repeat(64),
      toolchainSha256: "c".repeat(64),
      inputsSha256: "d".repeat(64),
      sbomSha256: "e".repeat(64),
    });
    expect(verifyEngineeringGraphArtifactAttestationTrust(root, attestationId)).toMatchObject({
      trusted: true,
      reason: "verified",
    });
    expect(listEngineeringGraphArtifactTrustVerifications(root)).toMatchObject([
      { attestation: { id: attestationId }, verification: { trusted: true, reason: "verified" } },
    ]);
    const rotated = generateKeyPairSync("ed25519");
    registerEngineeringGraphArtifactTrustKey(
      root,
      "release-2027",
      rotated.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    signEngineeringGraphArtifactAttestation(root, attestationId, {
      keyId: "release-2027",
      privateKeyPem: rotated.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      builderId: "ci-builder",
      environmentSha256: "b".repeat(64),
      toolchainSha256: "c".repeat(64),
      inputsSha256: "d".repeat(64),
    });
    revokeEngineeringGraphArtifactTrustKey(root, "release-2026");
    expect(verifyEngineeringGraphArtifactAttestationTrust(root, attestationId)).toMatchObject({
      trusted: true,
      reason: "verified",
      provenance: { keyId: "release-2027" },
    });
    revokeEngineeringGraphArtifactTrustKey(root, "release-2027");
    expect(verifyEngineeringGraphArtifactAttestationTrust(root, attestationId)).toMatchObject({
      trusted: false,
      reason: "key_revoked",
    });
  });
});
