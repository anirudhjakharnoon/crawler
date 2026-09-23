"use client";

interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export function Chip({ label, active, onClick, disabled }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-ac bg-ac/15 text-ac shadow-[0_0_12px_rgba(92,255,157,0.35)]"
          : "border-ac/20 text-ac/50 hover:border-ac/50 hover:text-ac/80"
      }`}
    >
      {active ? "▣" : "▢"} {label}
    </button>
  );
}
