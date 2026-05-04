import type { ReactNode } from "react";
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
export function ConfirmDialog({ title, children, confirmLabel = "Confirm", danger, onConfirm, onCancel }: Props) {
  return (
    <Modal
      title={title}
      onDismiss={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children && <div className="text-sm text-secondary">{children}</div>}
    </Modal>
  );
}
