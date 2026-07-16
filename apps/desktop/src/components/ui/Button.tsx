import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white font-medium hover:bg-accent-hover disabled:hover:bg-accent",
  ghost:
    "border border-strong text-secondary hover:bg-surface-overlay hover:text-primary disabled:hover:bg-transparent",
  danger: "bg-danger/85 text-white font-medium hover:bg-danger disabled:hover:bg-danger/85",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs gap-1.5",
  md: "px-4 py-1.5 text-sm gap-2",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/** The one button. Default ghost/md; `variant="primary"` is the single accent action per surface. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", type = "button", className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`focus-ring inline-flex items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    />
  );
});
