import { useState } from "react";
import { useT } from "../lib/i18n";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Input, Select, TextArea } from "../components/ui";
import type { GitRemoteInfo } from "../types";

/** Where a push of the checked-out branch lands, as the confirmation shows it. */
export function pushTarget(
  info: GitRemoteInfo,
  remote: string,
): { remote: string; branch: string; destination: string } | null {
  if (!info.branch || !info.remotes.includes(remote)) return null;
  const destination = info.upstream && info.upstream.remote === remote ? info.upstream.branch : info.branch;
  return { remote, branch: info.branch, destination };
}

/** The remote a push dialog starts on: the upstream's, else origin, else the first. */
export function defaultRemote(info: GitRemoteInfo): string {
  if (info.upstream) return info.upstream.remote;
  if (info.remotes.includes("origin")) return "origin";
  return info.remotes[0] ?? "";
}

/** Branch, upstream and ahead/behind, plus the Push and Create PR entry points. */
export function GitRemoteBar({
  info,
  busy,
  onPush,
  onCreatePr,
}: {
  info: GitRemoteInfo;
  busy: boolean;
  onPush: () => void;
  onCreatePr: () => void;
}) {
  const t = useT();
  const canPush = info.branch !== null && info.remotes.length > 0;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-subtle bg-surface-raised px-3 py-2">
      <span className="font-mono text-xs text-primary">{info.branch ?? t("git.detached")}</span>
      {info.upstream ? (
        <span className="font-mono text-2xs text-tertiary">
          → {info.upstream.remote}/{info.upstream.branch}
        </span>
      ) : (
        info.branch && <Badge tone="neutral">{t("git.noUpstream")}</Badge>
      )}
      {info.ahead !== null && info.ahead > 0 && <Badge tone="accent">{t("git.ahead", { count: info.ahead })}</Badge>}
      {info.behind !== null && info.behind > 0 && <Badge tone="warn">{t("git.behind", { count: info.behind })}</Badge>}
      <span className="ml-auto flex gap-2">
        <Button
          size="sm"
          onClick={onCreatePr}
          disabled={busy || !info.gh.available || info.branch === null}
          title={info.gh.available ? t("git.prTitle") : t("git.ghUnavailable")}
        >
          {t("git.createPr")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={onPush}
          disabled={busy || !canPush}
          title={canPush ? t("git.pushTitle") : info.branch === null ? t("git.detached") : t("git.noRemotes")}
        >
          {t("git.push")}
        </Button>
      </span>
      {!info.gh.available && <p className="w-full text-2xs text-tertiary">{t("git.ghUnavailable")}</p>}
    </div>
  );
}

export function PushDialog({
  info,
  onConfirm,
  onCancel,
}: {
  info: GitRemoteInfo;
  onConfirm: (remote: string, setUpstream: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [remote, setRemote] = useState(defaultRemote(info));
  const [setUpstream, setSetUpstream] = useState(info.upstream === null);
  const target = pushTarget(info, remote);
  return (
    <ConfirmDialog
      title={t("git.pushConfirmTitle")}
      confirmLabel={t("git.push")}
      confirmDisabled={target === null}
      onConfirm={() => target && onConfirm(target.remote, setUpstream)}
      onCancel={onCancel}
    >
      <div className="space-y-3 text-xs">
        {info.remotes.length > 1 && (
          <Select
            value={remote}
            onChange={setRemote}
            ariaLabel={t("git.remoteLabel")}
            className="w-full"
            options={info.remotes.map((name) => ({ value: name, label: name }))}
          />
        )}
        {target && (
          <pre className="overflow-x-auto rounded-lg border border-subtle bg-surface p-2.5 font-mono text-xs text-primary">
            {`git push ${setUpstream ? "--set-upstream " : ""}${target.remote} ${target.branch}:${target.destination}`}
          </pre>
        )}
        {info.upstream === null && (
          <label className="flex items-center gap-2 text-secondary">
            <input
              type="checkbox"
              checked={setUpstream}
              onChange={(e) => setSetUpstream(e.target.checked)}
              className="accent-accent"
            />
            {t("git.setUpstream")}
          </label>
        )}
        <p className="text-tertiary">{t("git.pushNeverForce")}</p>
      </div>
    </ConfirmDialog>
  );
}

export type PrInput = { title: string; body: string; draft: boolean; base: string };

export function PrDialog({
  branch,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  branch: string;
  busy: boolean;
  error: string | null;
  onSubmit: (input: PrInput) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const valid = title.trim() !== "" && !/[\r\n]/.test(title) && (base === "" || /^[A-Za-z0-9._/-]+$/.test(base));
  return (
    <ConfirmDialog
      title={t("git.prDialogTitle", { branch })}
      confirmLabel={busy ? t("git.prCreating") : t("git.createPr")}
      confirmDisabled={!valid || busy}
      onConfirm={() => onSubmit({ title: title.trim(), body, draft, base: base.trim() })}
      onCancel={onCancel}
    >
      <div className="space-y-2.5 text-xs">
        <label className="block" htmlFor="git-pr-title">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("git.prTitleLabel")}</span>
          <Input
            id="git-pr-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1"
            autoFocus
          />
        </label>
        <label className="block" htmlFor="git-pr-body">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("git.prBodyLabel")}</span>
          <TextArea id="git-pr-body" value={body} rows={6} onChange={(e) => setBody(e.target.value)} className="mt-1" />
        </label>
        <label className="block" htmlFor="git-pr-base">
          <span className="text-2xs uppercase tracking-wider text-tertiary">{t("git.prBaseLabel")}</span>
          <Input
            id="git-pr-base"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder={t("git.prBasePlaceholder")}
            className="mt-1 font-mono"
          />
        </label>
        <label className="flex items-center gap-2 text-secondary">
          <input
            type="checkbox"
            checked={draft}
            onChange={(e) => setDraft(e.target.checked)}
            className="accent-accent"
          />
          {t("git.prDraft")}
        </label>
        <p className="text-tertiary">{t("git.prPushFirst")}</p>
        {error && <p className="whitespace-pre-wrap font-mono text-danger">{error}</p>}
      </div>
    </ConfirmDialog>
  );
}
