import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isDenseArray, nextOrchestrationVersion } from "./orchestration.js";
import {
  listEngineeringGraphArtifactAttestations,
  type EngineeringGraphArtifactAttestation,
} from "./graph-artifact-store.js";
import { acquireSessionLease } from "./session-lease.js";

export type EngineeringGraphArtifactTrustKey = {
  keyId: string;
  algorithm: "ed25519";
  publicKeyPem: string;
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt?: string;
};

export type EngineeringGraphArtifactProvenance = {
  attestationId: string;
  keyId: string;
  signature: string;
  signedAt: string;
  builderId: string;
  environmentSha256: string;
  toolchainSha256: string;
  inputsSha256: string;
  sbomSha256?: string;
};

export type EngineeringGraphArtifactTrustVerification = {
  trusted: boolean;
  reason: "verified" | "attestation_missing" | "signature_missing" | "key_missing" | "key_revoked" | "invalid";
  provenance?: EngineeringGraphArtifactProvenance;
};

type Document = {
  version: 1;
  keys: EngineeringGraphArtifactTrustKey[];
  provenance: EngineeringGraphArtifactProvenance[];
};

const PATH = ".seekforge/artifacts/trust.json";
const MAX_BYTES = 512 * 1024;
const MAX_KEYS = 64;
const MAX_PROVENANCE = 1_024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validKey(value: unknown): value is EngineeringGraphArtifactTrustKey {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["keyId", "algorithm", "publicKeyPem", "fingerprint", "status", "createdAt", "revokedAt"]) &&
    typeof value.keyId === "string" &&
    ID_RE.test(value.keyId) &&
    value.algorithm === "ed25519" &&
    typeof value.publicKeyPem === "string" &&
    value.publicKeyPem.length >= 32 &&
    value.publicKeyPem.length <= 8_192 &&
    typeof value.fingerprint === "string" &&
    HASH_RE.test(value.fingerprint) &&
    (value.status === "active" || value.status === "revoked") &&
    validTimestamp(value.createdAt) &&
    (value.revokedAt === undefined ||
      (validTimestamp(value.revokedAt) && Date.parse(value.revokedAt) >= Date.parse(value.createdAt))) &&
    (value.status === "revoked") === (value.revokedAt !== undefined)
  );
}

function validProvenance(value: unknown): value is EngineeringGraphArtifactProvenance {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "attestationId",
      "keyId",
      "signature",
      "signedAt",
      "builderId",
      "environmentSha256",
      "toolchainSha256",
      "inputsSha256",
      "sbomSha256",
    ]) &&
    typeof value.attestationId === "string" &&
    HASH_RE.test(value.attestationId) &&
    typeof value.keyId === "string" &&
    ID_RE.test(value.keyId) &&
    typeof value.signature === "string" &&
    /^[A-Za-z0-9_-]{64,512}$/.test(value.signature) &&
    validTimestamp(value.signedAt) &&
    typeof value.builderId === "string" &&
    ID_RE.test(value.builderId) &&
    [value.environmentSha256, value.toolchainSha256, value.inputsSha256].every(
      (digest) => typeof digest === "string" && HASH_RE.test(digest),
    ) &&
    (value.sbomSha256 === undefined || (typeof value.sbomSha256 === "string" && HASH_RE.test(value.sbomSha256)))
  );
}

function emptyDocument(): Document {
  return { version: 1, keys: [], provenance: [] };
}

function readDocument(workspace: string): Document {
  const raw = readWorkspaceStateFile(workspace, PATH, MAX_BYTES);
  if (raw === undefined) return emptyDocument();
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "keys", "provenance"]) ||
    value.version !== 1 ||
    !isDenseArray(value.keys) ||
    value.keys.length > MAX_KEYS ||
    !value.keys.every(validKey) ||
    new Set(value.keys.map((key) => key.keyId)).size !== value.keys.length ||
    !isDenseArray(value.provenance) ||
    value.provenance.length > MAX_PROVENANCE ||
    !value.provenance.every(validProvenance) ||
    new Set(value.provenance.map((item) => `${item.attestationId}\0${item.keyId}`)).size !== value.provenance.length
  ) {
    throw new Error("Persisted Graph artifact trust state is invalid");
  }
  return value as Document;
}

function writeDocument(workspace: string, document: Document): void {
  let retained = [...document.provenance];
  let serialized = `${JSON.stringify({ ...document, provenance: retained })}\n`;
  while (Buffer.byteLength(serialized) > MAX_BYTES && retained.length > 1) {
    retained = retained.slice(1);
    serialized = `${JSON.stringify({ ...document, provenance: retained })}\n`;
  }
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Graph artifact trust state exceeds limit");
  writeWorkspaceStateFileAtomic(workspace, PATH, serialized);
}

function exportedPublicKey(publicKeyPem: string): { pem: string; fingerprint: string } {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Graph artifact trust key must be Ed25519");
  const pem = key.export({ type: "spki", format: "pem" }).toString();
  return {
    pem,
    fingerprint: createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
}

function signingPayload(
  attestation: EngineeringGraphArtifactAttestation,
  provenance: Omit<EngineeringGraphArtifactProvenance, "signature">,
): Buffer {
  return Buffer.from(JSON.stringify({ attestation, provenance }), "utf8");
}

export function registerEngineeringGraphArtifactTrustKey(
  workspace: string,
  keyId: string,
  publicKeyPem: string,
): EngineeringGraphArtifactTrustKey {
  if (!ID_RE.test(keyId)) throw new Error("Graph artifact trust key id is invalid");
  if (typeof publicKeyPem !== "string" || publicKeyPem.length < 32 || publicKeyPem.length > 8_192) {
    throw new Error("Graph artifact public key is invalid");
  }
  const exported = exportedPublicKey(publicKeyPem);
  const lease = acquireSessionLease(workspace, "graph-artifact-trust");
  try {
    const document = readDocument(workspace);
    const existing = document.keys.find((key) => key.keyId === keyId);
    if (existing) {
      if (existing.fingerprint !== exported.fingerprint) throw new Error("Graph artifact trust key id already exists");
      return existing;
    }
    if (document.keys.length >= MAX_KEYS) throw new Error("Graph artifact trust key limit reached");
    const key: EngineeringGraphArtifactTrustKey = {
      keyId,
      algorithm: "ed25519",
      publicKeyPem: exported.pem,
      fingerprint: exported.fingerprint,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    writeDocument(workspace, { ...document, keys: [...document.keys, key] });
    return key;
  } finally {
    lease.release();
  }
}

export function revokeEngineeringGraphArtifactTrustKey(
  workspace: string,
  keyId: string,
): EngineeringGraphArtifactTrustKey {
  if (!ID_RE.test(keyId)) throw new Error("Graph artifact trust key id is invalid");
  const lease = acquireSessionLease(workspace, "graph-artifact-trust");
  try {
    const document = readDocument(workspace);
    const existing = document.keys.find((key) => key.keyId === keyId);
    if (!existing) throw new Error(`Graph artifact trust key not found: ${keyId}`);
    if (existing.status === "revoked") return existing;
    const revoked: EngineeringGraphArtifactTrustKey = {
      ...existing,
      status: "revoked",
      revokedAt: nextOrchestrationVersion(existing.createdAt),
    };
    writeDocument(workspace, {
      ...document,
      keys: document.keys.map((key) => (key.keyId === keyId ? revoked : key)),
    });
    return revoked;
  } finally {
    lease.release();
  }
}

export function signEngineeringGraphArtifactAttestation(
  workspace: string,
  attestationId: string,
  input: {
    keyId: string;
    privateKeyPem: string;
    builderId: string;
    environmentSha256: string;
    toolchainSha256: string;
    inputsSha256: string;
    sbomSha256?: string;
  },
): EngineeringGraphArtifactProvenance {
  if (!HASH_RE.test(attestationId)) throw new Error("Graph artifact attestation id is invalid");
  if (
    !ID_RE.test(input.keyId) ||
    !ID_RE.test(input.builderId) ||
    typeof input.privateKeyPem !== "string" ||
    input.privateKeyPem.length < 32 ||
    input.privateKeyPem.length > 16_384 ||
    ![input.environmentSha256, input.toolchainSha256, input.inputsSha256].every((digest) => HASH_RE.test(digest)) ||
    (input.sbomSha256 !== undefined && !HASH_RE.test(input.sbomSha256))
  ) {
    throw new Error("Graph artifact signing input is invalid");
  }
  const lease = acquireSessionLease(workspace, "graph-artifact-trust");
  try {
    const document = readDocument(workspace);
    const key = document.keys.find((candidate) => candidate.keyId === input.keyId);
    if (key?.status !== "active") throw new Error("Graph artifact trust key is unavailable");
    const attestation = listEngineeringGraphArtifactAttestations(workspace).find((item) => item.id === attestationId);
    if (!attestation) throw new Error(`Graph artifact attestation not found: ${attestationId}`);
    const privateKey = createPrivateKey(input.privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Graph artifact signing key must be Ed25519");
    const derived = exportedPublicKey(createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString());
    if (derived.fingerprint !== key.fingerprint) throw new Error("Graph artifact signing key does not match trust key");
    const unsigned: Omit<EngineeringGraphArtifactProvenance, "signature"> = {
      attestationId,
      keyId: input.keyId,
      signedAt: new Date().toISOString(),
      builderId: input.builderId,
      environmentSha256: input.environmentSha256,
      toolchainSha256: input.toolchainSha256,
      inputsSha256: input.inputsSha256,
      ...(input.sbomSha256 ? { sbomSha256: input.sbomSha256 } : {}),
    };
    const provenance: EngineeringGraphArtifactProvenance = {
      ...unsigned,
      signature: signBytes(null, signingPayload(attestation, unsigned), privateKey).toString("base64url"),
    };
    if (!validProvenance(provenance)) throw new Error("Graph artifact provenance is invalid");
    const retained = document.provenance.filter(
      (item) => item.attestationId !== attestationId || item.keyId !== input.keyId,
    );
    writeDocument(workspace, { ...document, provenance: [...retained, provenance].slice(-MAX_PROVENANCE) });
    return provenance;
  } finally {
    lease.release();
  }
}

export function verifyEngineeringGraphArtifactAttestationTrust(
  workspace: string,
  attestationId: string,
): EngineeringGraphArtifactTrustVerification {
  if (!HASH_RE.test(attestationId)) throw new Error("Graph artifact attestation id is invalid");
  const document = readDocument(workspace);
  const attestation = listEngineeringGraphArtifactAttestations(workspace).find((item) => item.id === attestationId);
  if (!attestation) return { trusted: false, reason: "attestation_missing" };
  const provenance = document.provenance
    .filter((item) => item.attestationId === attestationId)
    .sort((left, right) => Date.parse(right.signedAt) - Date.parse(left.signedAt));
  if (provenance.length === 0) return { trusted: false, reason: "signature_missing" };
  let missingKey = false;
  let revoked = false;
  let activeInvalid = false;
  for (const candidate of provenance) {
    const key = document.keys.find((item) => item.keyId === candidate.keyId);
    if (!key) {
      missingKey = true;
      continue;
    }
    if (key.status === "revoked") {
      revoked = true;
      continue;
    }
    const { signature, ...unsigned } = candidate;
    if (
      verifyBytes(
        null,
        signingPayload(attestation, unsigned),
        createPublicKey(key.publicKeyPem),
        Buffer.from(signature, "base64url"),
      )
    ) {
      return { trusted: true, reason: "verified", provenance: candidate };
    }
    activeInvalid = true;
  }
  const latest = provenance[0]!;
  if (activeInvalid) return { trusted: false, reason: "invalid", provenance: latest };
  if (revoked && !missingKey) return { trusted: false, reason: "key_revoked", provenance: latest };
  if (missingKey) return { trusted: false, reason: "key_missing", provenance: latest };
  return { trusted: false, reason: "invalid", provenance: latest };
}

export function listEngineeringGraphArtifactTrustKeys(workspace: string): EngineeringGraphArtifactTrustKey[] {
  return readDocument(workspace).keys;
}
