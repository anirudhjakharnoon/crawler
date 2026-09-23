"use client";

import { useEffect, useRef } from "react";
import type { CrawlEventRow } from "@/lib/supabase/types";

const KIND_COLOR: Record<string, string> = {
  fetch: "text-ac/80",
  extract: "text-ac/60",
  queue: "text-ac/40",
  skip: "text-warn",
  error: "text-danger",
  done: "text-ac text-glow",
};

export function EventLog({ events }: { events: CrawlEventRow[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div
      ref={scrollRef}
      className="h-full min-h-[220px] overflow-y-auto rounded-sm border border-ac/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed"
    >
      {events.length === 0 && <p className="text-ac/30">No events yet — logs stream in once a run starts.</p>}
      {events.map((e) => (
        <div key={e.id} className="flex gap-2">
          <span className="shrink-0 text-ac/30">{new Date(e.at).toLocaleTimeString()}</span>
          <span className={`shrink-0 uppercase ${KIND_COLOR[e.kind] ?? "text-ac/60"}`}>[{e.kind}]</span>
          <span className="break-all text-ac/70">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
