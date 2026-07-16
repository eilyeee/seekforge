import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

const FIELD =
  "w-full rounded-lg border border-strong bg-surface px-3 py-1.5 text-sm text-primary " +
  "placeholder:text-tertiary focus:border-accent/70 focus:outline-none focus:ring-1 focus:ring-accent/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = "", ...rest },
  ref,
) {
  return <input ref={ref} className={`${FIELD} ${className}`} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className = "", ...rest },
  ref,
) {
  return <textarea ref={ref} className={`${FIELD} resize-none ${className}`} {...rest} />;
});
