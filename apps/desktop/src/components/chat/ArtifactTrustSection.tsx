import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type {
  EngineeringGraphArtifactAttestation,
  EngineeringGraphArtifactTrustKey,
  EngineeringGraphArtifactTrustVerification,
} from "../../types";
import { Badge, Button } from "../ui";

type TrustState = {
  keys: EngineeringGraphArtifactTrustKey[];
  attestations: Array<{
    attestation: EngineeringGraphArtifactAttestation;
    verification: EngineeringGraphArtifactTrustVerification;
  }>;
};

const EMPTY_SIGNING_FORM = {
  attestationId: "",
  keyId: "",
  privateKeyPem: "",
  builderId: "",
  environmentSha256: "",
  toolchainSha256: "",
  inputsSha256: "",
  sbomSha256: "",
};

export function ArtifactTrustSection(props: { workspaceId?: string }) {
  const t = useT();
  const generation = useRef(0);
  const [state, setState] = useState<TrustState>({ keys: [], attestations: [] });
  const [keyId, setKeyId] = useState("");
  const [publicKeyPem, setPublicKeyPem] = useState("");
  const [signing, setSigning] = useState(EMPTY_SIGNING_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const next = await api.graphArtifactTrust(props.workspaceId);
      if (generation.current === request) {
        setState(next);
        setError("");
      }
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [props.workspaceId]);

  const register = async () => {
    if (!keyId.trim() || !publicKeyPem.trim()) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      await api.graphArtifactTrustRegister(keyId.trim(), publicKeyPem.trim(), props.workspaceId);
      if (generation.current === request) {
        setKeyId("");
        setPublicKeyPem("");
        await refresh();
      }
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm(t("chat.loop.trust.revokeConfirm", { id }))) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      await api.graphArtifactTrustRevoke(id, props.workspaceId);
      if (generation.current === request) await refresh();
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  const sign = async () => {
    const required = [
      signing.attestationId,
      signing.keyId,
      signing.privateKeyPem,
      signing.builderId,
      signing.environmentSha256,
      signing.toolchainSha256,
      signing.inputsSha256,
    ];
    if (required.some((value) => !value.trim())) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      await api.graphArtifactTrustSign(
        {
          attestationId: signing.attestationId.trim(),
          keyId: signing.keyId.trim(),
          privateKeyPem: signing.privateKeyPem.trim(),
          builderId: signing.builderId.trim(),
          environmentSha256: signing.environmentSha256.trim(),
          toolchainSha256: signing.toolchainSha256.trim(),
          inputsSha256: signing.inputsSha256.trim(),
          ...(signing.sbomSha256.trim() ? { sbomSha256: signing.sbomSha256.trim() } : {}),
        },
        props.workspaceId,
      );
      if (generation.current === request) {
        setSigning(EMPTY_SIGNING_FORM);
        await refresh();
      }
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  return (
    <details className="mt-3 rounded border border-subtle p-2 text-xs text-secondary">
      <summary className="cursor-pointer font-medium">{t("chat.loop.trust.title")}</summary>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-tertiary">
          {state.keys.length} {t("chat.loop.trust.keys")} · {state.attestations.length} {t("chat.loop.trust.artifacts")}
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {t("chat.loop.trust.refresh")}
        </Button>
      </div>
      {error && <p className="mt-2 text-danger">{error}</p>}
      <div className="mt-2 space-y-1">
        {state.keys.map((key) => (
          <div key={key.keyId} className="flex flex-wrap items-center gap-1 rounded border border-subtle p-1">
            <Badge tone={key.status === "active" ? "ok" : "neutral"}>{key.status}</Badge>
            <span>{key.keyId}</span>
            <span className="break-all text-tertiary">{key.fingerprint}</span>
            {key.status === "active" && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(key.keyId)}>
                {t("chat.loop.trust.revoke")}
              </Button>
            )}
          </div>
        ))}
      </div>
      <details className="mt-2 rounded border border-subtle p-2">
        <summary className="cursor-pointer">{t("chat.loop.trust.register")}</summary>
        <input
          className="mt-2 w-full rounded border border-subtle bg-surface px-2 py-1"
          value={keyId}
          placeholder={t("chat.loop.trust.keyId")}
          onChange={(event) => setKeyId(event.target.value)}
        />
        <textarea
          className="mt-2 h-24 w-full rounded border border-subtle bg-surface p-2 font-mono text-2xs"
          value={publicKeyPem}
          placeholder={t("chat.loop.trust.publicKey")}
          onChange={(event) => setPublicKeyPem(event.target.value)}
        />
        <Button size="sm" disabled={busy || !keyId.trim() || !publicKeyPem.trim()} onClick={() => void register()}>
          {t("chat.loop.trust.register")}
        </Button>
      </details>
      <div className="mt-2 space-y-1">
        {state.attestations.map(({ attestation, verification }) => (
          <div key={attestation.id} className="rounded border border-subtle p-1">
            <div className="flex flex-wrap items-center gap-1">
              <Badge tone={verification.trusted ? "ok" : "warn"}>{verification.reason}</Badge>
              <span>{attestation.id}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  setSigning((current) => ({
                    ...current,
                    attestationId: attestation.id,
                    keyId: current.keyId || state.keys.find((key) => key.status === "active")?.keyId || "",
                  }))
                }
              >
                {t("chat.loop.trust.sign")}
              </Button>
            </div>
            <p className="break-all text-tertiary">sha256:{attestation.sha256}</p>
          </div>
        ))}
      </div>
      {signing.attestationId && (
        <details open className="mt-2 rounded border border-subtle p-2">
          <summary className="cursor-pointer">
            {t("chat.loop.trust.signArtifact", { id: signing.attestationId })}
          </summary>
          {(
            [
              ["keyId", t("chat.loop.trust.keyId")],
              ["builderId", t("chat.loop.trust.builder")],
              ["environmentSha256", "environment sha256"],
              ["toolchainSha256", "toolchain sha256"],
              ["inputsSha256", "inputs sha256"],
              ["sbomSha256", "SBOM sha256 (optional)"],
            ] as const
          ).map(([field, placeholder]) => (
            <input
              key={field}
              className="mt-2 w-full rounded border border-subtle bg-surface px-2 py-1 font-mono"
              value={signing[field]}
              placeholder={placeholder}
              onChange={(event) => setSigning((current) => ({ ...current, [field]: event.target.value }))}
            />
          ))}
          <textarea
            className="mt-2 h-28 w-full rounded border border-subtle bg-surface p-2 font-mono text-2xs"
            value={signing.privateKeyPem}
            placeholder={t("chat.loop.trust.privateKey")}
            onChange={(event) => setSigning((current) => ({ ...current, privateKeyPem: event.target.value }))}
          />
          <p className="mb-2 text-tertiary">{t("chat.loop.trust.privateKeyHint")}</p>
          <Button size="sm" disabled={busy} onClick={() => void sign()}>
            {t("chat.loop.trust.sign")}
          </Button>
        </details>
      )}
    </details>
  );
}
