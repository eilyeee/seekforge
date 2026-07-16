import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  /** Skip the default padding (e.g. when the card holds a <pre>). */
  flush?: boolean;
};

/** Raised panel: soft border, xl radius. The base building block for grouped content. */
export function Card({ flush, className = "", ...rest }: Props) {
  return (
    <div className={`rounded-xl border border-subtle bg-surface-raised ${flush ? "" : "p-4"} ${className}`} {...rest} />
  );
}
