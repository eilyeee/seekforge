import type { ReactNode } from "react";
import { useT } from "../lib/i18n";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

type Props = {
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Small confirm modal (Escape / backdrop = cancel). */
export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const t = useT();
  const label = confirmLabel ?? t("action.confirm");
  return (
    <Modal
      title={title}
      onDismiss={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t("action.cancel")}</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} autoFocus>
            {label}
          </Button>
        </>
      }
    >
      {children && <div className="text-sm text-secondary">{children}</div>}
    </Modal>
  );
}
