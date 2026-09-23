import { STATE_COLORS, STATE_LABELS, type UiState } from "@/lib/client/uiState";

export function StatePill({ state }: { state: UiState }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-sm border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.2em] ${STATE_COLORS[state]}`}
      data-state={state}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
      </span>
      {STATE_LABELS[state]}
    </span>
  );
}
