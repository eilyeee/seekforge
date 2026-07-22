import { useEffect, useId, useRef, type ReactNode } from "react";

type Props = {
  /** Header line; pass a fragment for title + badges. */
  title?: ReactNode;
  children?: ReactNode;
  /** Right-aligned action row; usually Buttons. */
  footer?: ReactNode;
  /** Called on Escape / backdrop click. */
  onDismiss: () => void;
  /** max-w-md (default) or max-w-lg. */
  wide?: boolean;
};

/**
 * Shared modal shell: dimmed backdrop, raised card, Escape / backdrop dismiss.
 * Callers decide what dismissal means (cancel, deny, decline...).
 */
export function Modal({ title, children, footer, onDismiss, wide }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  const titleId = useId();

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusableSelector = [
      "button:not([disabled])",
      "[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    if (dialog && !dialog.contains(document.activeElement)) {
      const initialFocus =
        dialog.querySelector<HTMLElement>("[autofocus]") ??
        dialog.querySelector<HTMLElement>(focusableSelector) ??
        dialog;
      initialFocus.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      const currentDialog = dialogRef.current;
      if (!currentDialog) return;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs.item(dialogs.length - 1) !== currentDialog) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismissRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = [...currentDialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        e.preventDefault();
        currentDialog.focus();
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && activeIndex <= 0) {
        e.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!e.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1)) {
        e.preventDefault();
        focusable[0]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onDismiss}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title === undefined ? undefined : titleId}
        aria-label={title === undefined ? "Dialog" : undefined}
        tabIndex={-1}
        className={`relative flex max-h-[calc(100vh-2rem)] w-full flex-col ${wide ? "max-w-lg" : "max-w-md"} rounded-xl border border-subtle bg-surface-raised p-5 shadow-2xl shadow-black/50`}
      >
        {title !== undefined && (
          <div id={titleId} className="mb-3 flex shrink-0 items-center gap-2 text-sm font-semibold text-primary">
            {title}
          </div>
        )}
        <div className="min-h-0 overflow-y-auto">{children}</div>
        {footer !== undefined && <div className="mt-4 flex shrink-0 justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
