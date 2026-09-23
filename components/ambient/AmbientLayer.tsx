"use client";

/**
 * Purely decorative, always-on visual layer — scanline sweep, drifting
 * particles, and a marquee ticker. Reads NO backend state whatsoever; every
 * value here is generated client-side once on mount. Fully disabled when
 * the user has `prefers-reduced-motion: reduce` set (checked in JS here,
 * and backed up by a CSS media query in globals.css in case this check
 * somehow doesn't run before paint).
 */
import { useEffect, useState } from "react";

interface Particle {
  id: number;
  left: string;
  top: string;
  duration: string;
  delay: string;
  driftX: string;
  driftY: string;
}

const TICKER_ITEMS = [
  "SYS://CRAWLR ONLINE",
  "STATIC HTML EXTRACTION ONLY",
  "ROBOTS.TXT: HONORED",
  "NO JS RENDERING",
  "NO AI · NO LLM CALLS",
  "SSRF SHIELD: ARMED",
  "RATE LIMIT: ENFORCED",
  "DATA MINIMIZATION: ON",
];

function generateParticles(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 100}%`,
    duration: `${8 + Math.random() * 10}s`,
    delay: `${Math.random() * -12}s`,
    driftX: `${(Math.random() - 0.5) * 160}px`,
    driftY: `${-(60 + Math.random() * 160)}px`,
  }));
}

export function AmbientLayer() {
  const [particles, setParticles] = useState<Particle[]>([]);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener("change", handler);

    if (!mql.matches) {
      setParticles(generateParticles(22));
    }

    return () => mql.removeEventListener("change", handler);
  }, []);

  return (
    <div
      className={`ambient-layer ${reducedMotion ? "ambient-disabled" : ""}`}
      aria-hidden="true"
      data-testid="ambient-layer"
    >
      <div className="ambient-scanline" />
      {particles.map((p) => (
        <span
          key={p.id}
          className="ambient-particle"
          style={{
            left: p.left,
            top: p.top,
            animationDuration: p.duration,
            animationDelay: p.delay,
            "--drift-x": p.driftX,
            "--drift-y": p.driftY,
          } as React.CSSProperties}
        />
      ))}
      <div className="absolute bottom-0 left-0 right-0 border-t border-ac/10 bg-black/40 py-1 overflow-hidden">
        <div className="ambient-marquee-track font-mono text-[10px] tracking-[0.25em] text-ac/50">
          {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
            <span key={i} className="mx-6">
              {item}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
