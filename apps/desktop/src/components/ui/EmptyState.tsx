import type { ReactNode } from "react";

type Props = {
  /** Optional pictogram (usually an icon from ui/icons at size 24+). */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Optional call to action (usually a primary Button). */
  action?: ReactNode;
};

/** Centered empty placeholder for views with nothing to show yet. */
export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="mb-1 text-tertiary">{icon}</div>}
      <div className="text-sm font-medium text-secondary">{title}</div>
      {description && <div className="max-w-sm text-xs leading-relaxed text-tertiary">{description}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
