import type { ReactNode } from "react";

interface PanelProps {
  label: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}

export function Panel({ label, children, className = "", actions }: PanelProps) {
  return (
    <section className={`crt-corner panel-glass relative rounded-md p-4 ${className}`}>
      <header className="mb-3 flex items-center justify-between border-b border-ac/10 pb-2">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.3em] text-ac/70">
          {label}
        </h2>
        {actions}
      </header>
      {children}
    </section>
  );
}
