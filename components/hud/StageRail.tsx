import type { UiState } from "@/lib/client/uiState";

interface StageRailProps {
  state: UiState;
  hasProbe: boolean;
  ackPermission: boolean;
}

const STAGES = ["TARGET", "SCOPE", "RUN"] as const;

export function StageRail({ state, hasProbe, ackPermission }: StageRailProps) {
  const activeIndex = state === "running" || state === "completed" || state === "capped" || state === "partial" || state === "aborted"
    ? 2
    : ackPermission
    ? 2
    : hasProbe
    ? 1
    : 0;

  return (
    <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.25em]">
      {STAGES.map((stage, i) => (
        <div key={stage} className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${
                i <= activeIndex ? "border-ac bg-ac/10 text-ac" : "border-ac/20 text-ac/30"
              }`}
            >
              {i + 1}
            </span>
            <span className={i <= activeIndex ? "text-ac" : "text-ac/30"}>{stage}</span>
          </div>
          {i < STAGES.length - 1 && (
            <span className={`h-px w-8 ${i < activeIndex ? "bg-ac/60" : "bg-ac/15"}`} />
          )}
        </div>
      ))}
    </div>
  );
}
