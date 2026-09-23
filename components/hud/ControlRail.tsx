"use client";

import { useMemo, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Panel } from "@/components/ui/Panel";
import { CONTENT_TYPES, DEFAULT_MAX_PAGES, SCOPES, type ContentType, type Scope } from "@/lib/constants";
import type { ProbeResult } from "@/lib/crawl/probe";
import type { CrawlJobRow } from "@/lib/supabase/types";

const SCOPE_LABELS: Record<Scope, string> = {
  page: "This URL only",
  linked: "URL + linked pages",
  site: "Entire website",
};

const SCOPE_HINTS: Record<Scope, string> = {
  page: "depth 0 — just this page",
  linked: "depth 1 — page + same-domain pages it links to",
  site: "BFS across the whole domain, capped",
};

const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  text: "Text",
  images: "Images",
  video: "Video",
};

interface ControlRailProps {
  url: string;
  onUrlChange: (value: string) => void;
  onProbe: () => void;
  probing: boolean;
  probeResult: ProbeResult | null;
  probeError: string | null;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  contentTypes: ContentType[];
  onToggleContentType: (ct: ContentType) => void;
  ackPermission: boolean;
  onAckPermissionChange: (checked: boolean) => void;
  onRun: () => void;
  runDisabled: boolean;
  runError: string | null;
  activeJob: CrawlJobRow | null;
  onAbort: () => void;
  submitting: boolean;
}

function estimatePageCount(scope: Scope, probeResult: ProbeResult | null): string {
  if (!probeResult || !probeResult.ok) return "—";
  if (scope === "page") return "1";
  if (scope === "linked") {
    const n = Math.min(1 + probeResult.sameOriginLinkCount, DEFAULT_MAX_PAGES);
    return `~${n}`;
  }
  const sitemapCount = probeResult.sitemap.found ? probeResult.sitemap.urlCount : probeResult.sameOriginLinkCount;
  const n = Math.min(Math.max(sitemapCount, 1), DEFAULT_MAX_PAGES);
  return `~${n} (cap ${DEFAULT_MAX_PAGES})`;
}

export function ControlRail(props: ControlRailProps) {
  const {
    url,
    onUrlChange,
    onProbe,
    probing,
    probeResult,
    probeError,
    scope,
    onScopeChange,
    contentTypes,
    onToggleContentType,
    ackPermission,
    onAckPermissionChange,
    onRun,
    runDisabled,
    runError,
    activeJob,
    onAbort,
    submitting,
  } = props;

  const isJobActive = activeJob?.status === "running";
  const estimate = useMemo(() => estimatePageCount(scope, probeResult), [scope, probeResult]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (url.trim()) onProbe();
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel label="Target">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              type="url"
              inputMode="url"
              placeholder="https://example.com"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              disabled={isJobActive}
              className="flex-1 rounded-sm border border-ac/25 bg-black/40 px-3 py-2 font-mono text-sm text-ac placeholder:text-ac/30 focus:border-ac focus:outline-none focus:ring-1 focus:ring-ac/40 disabled:opacity-40"
              aria-label="Target URL"
            />
            <Button type="submit" variant="outline" disabled={!url.trim() || probing || isJobActive}>
              {probing ? "…" : "Probe"}
            </Button>
          </div>

          <div className="min-h-[64px] rounded-sm border border-ac/10 bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-ac/70">
            {probing && <p className="text-warn">◌ resolving target…</p>}
            {!probing && probeError && <p className="text-danger">✕ {probeError}</p>}
            {!probing && probeResult && probeResult.ok && (
              <div className="space-y-1">
                <p>
                  <span className="text-ac">RESOLVED</span> · <span>{probeResult.statusCode} OK</span> ·{" "}
                  <span>{probeResult.sameOriginLinkCount} LINKS FOUND</span>
                </p>
                <p className={probeResult.robots.allowed ? "text-ac/60" : "text-warn"}>
                  robots.txt: {probeResult.robots.hasRobotsTxt ? (probeResult.robots.allowed ? "ALLOWED" : "DISALLOWED") : "NOT FOUND (allow-all)"}
                </p>
                <p className="text-ac/50">
                  sitemap.xml: {probeResult.sitemap.found ? `FOUND (${probeResult.sitemap.urlCount} urls)` : "NOT FOUND"}
                </p>
              </div>
            )}
            {!probing && probeResult && !probeResult.ok && (
              <p className="text-danger">✕ {probeResult.error ?? "Unreachable"}</p>
            )}
            {!probing && !probeResult && !probeError && <p className="text-ac/30">awaiting target…</p>}
          </div>
        </form>
      </Panel>

      <Panel label="Content">
        <div className="flex flex-wrap gap-2">
          {CONTENT_TYPES.map((ct) => (
            <Chip
              key={ct}
              label={CONTENT_TYPE_LABELS[ct]}
              active={contentTypes.includes(ct)}
              disabled={isJobActive}
              onClick={() => onToggleContentType(ct)}
            />
          ))}
        </div>
      </Panel>

      <Panel label="Scope">
        <div className="flex flex-col gap-2">
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={isJobActive}
              onClick={() => onScopeChange(s)}
              className={`rounded-sm border px-3 py-2 text-left font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                scope === s ? "border-ac bg-ac/10 text-ac" : "border-ac/15 text-ac/60 hover:border-ac/40"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="uppercase tracking-[0.1em]">{SCOPE_LABELS[s]}</span>
                {scope === s && <span className="text-ac/70">{estimate} pages</span>}
              </div>
              <div className="mt-0.5 text-[10px] text-ac/40">{SCOPE_HINTS[s]}</div>
            </button>
          ))}
        </div>
      </Panel>

      <Panel label="Authorize">
        <label className="flex cursor-pointer items-start gap-2 text-[11px] text-ac/70">
          <input
            type="checkbox"
            checked={ackPermission}
            disabled={isJobActive}
            onChange={(e) => onAckPermissionChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#5cff9d]"
          />
          <span>
            Crawling is limited to public, non-authenticated content. This tool will not bypass
            logins, paywalls, or CAPTCHAs. I am responsible for having the right to crawl this
            target.
          </span>
        </label>

        {isJobActive ? (
          <Button variant="danger" className="mt-3 w-full" onClick={onAbort}>
            Abort run
          </Button>
        ) : (
          <Button
            variant="primary"
            className="mt-3 w-full"
            disabled={runDisabled || submitting}
            onClick={onRun}
          >
            {submitting ? "Launching…" : "Run"}
          </Button>
        )}
        {runError && <p className="mt-2 font-mono text-[11px] text-danger">✕ {runError}</p>}
      </Panel>
    </div>
  );
}
