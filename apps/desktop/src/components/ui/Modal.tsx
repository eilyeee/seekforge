import { useEffect, type ReactNode } from "react";

type Props = {
  /** Header line; pass a fragment for title + badges. */
  title?: ReactNode;
  children: ReactNode;
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full ${wide ? "max-w-lg" : "max-w-md"} rounded-xl border border-subtle bg-surface-raised p-5 shadow-2xl shadow-black/50`}
        onClick={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary">{title}</div>
        )}
        {children}
        {footer !== undefined && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
