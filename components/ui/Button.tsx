"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger" | "outline";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-ac text-void-950 border-ac shadow-[0_0_18px_rgba(92,255,157,0.45)] hover:shadow-[0_0_28px_rgba(92,255,157,0.65)] hover:bg-ac-glow disabled:bg-ac-dim disabled:shadow-none disabled:text-void-800",
  outline:
    "bg-transparent text-ac border-ac/50 hover:border-ac hover:bg-ac/10 disabled:text-ac-dim disabled:border-ac-dim/30",
  ghost:
    "bg-transparent text-ac/70 border-transparent hover:text-ac hover:bg-ac/5 disabled:text-ac-dim/50",
  danger:
    "bg-transparent text-danger border-danger/50 hover:bg-danger/10 hover:border-danger disabled:text-danger/30 disabled:border-danger/10",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", className = "", children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={`group relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border px-4 py-2 font-mono text-xs font-medium uppercase tracking-[0.15em] transition-all duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:active:scale-100 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      <span className="relative z-10">{children}</span>
      <span className="pointer-events-none absolute inset-0 -z-0 origin-left scale-x-0 bg-white/10 transition-transform duration-300 group-active:scale-x-100" />
    </button>
  );
});
