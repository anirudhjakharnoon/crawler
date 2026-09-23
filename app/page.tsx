"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ControlRail } from "@/components/hud/ControlRail";
import { EventLog } from "@/components/hud/EventLog";
import { LinkGraph } from "@/components/hud/LinkGraph";
import { ResultPanel } from "@/components/hud/ResultPanel";
import { RunHistoryDrawer } from "@/components/hud/RunHistoryDrawer";
import { StageRail } from "@/components/hud/StageRail";
import { StatePill } from "@/components/hud/StatePill";
import { useAuth } from "@/components/providers/AuthProvider";
import { useJobAssets } from "@/hooks/useJobAssets";
import { useJobRealtime } from "@/hooks/useJobRealtime";
import { useRunHistory } from "@/hooks/useRunHistory";
import { abortJob, createJob, probeTarget } from "@/lib/client/api";
import { type ContentType, type Scope } from "@/lib/constants";
import type { ProbeResult } from "@/lib/crawl/probe";
import { deriveUiState } from "@/lib/client/uiState";
import type { CrawlJobRow } from "@/lib/supabase/types";

type DrawerTab = "log" | "history";

export default function HomePage() {
  const { ready, error: authError } = useAuth();

  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<Scope>("page");
  const [contentTypes, setContentTypes] = useState<ContentType[]>(["text"]);
  const [ackPermission, setAckPermission] = useState(false);

  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("log");

  const { job, events, loading: jobLoading } = useJobRealtime(activeJobId);
  const assets = useJobAssets(activeJobId);
  const { jobs: history, loading: historyLoading, refresh: refreshHistory } = useRunHistory(ready);

  const uiState = useMemo(() => deriveUiState({ job, probing, probeResult }), [job, probing, probeResult]);

  useEffect(() => {
    if (job && (job.status === "completed" || job.status === "failed" || job.status === "aborted")) {
      void refreshHistory();
    }
    // Deliberately keyed on status alone — refreshing on every counter tick
    // of the same job would be wasteful; we only care about terminal
    // transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, refreshHistory]);

  async function handleProbe() {
    setProbing(true);
    setProbeError(null);
    setProbeResult(null);
    try {
      const result = await probeTarget(url.trim());
      setProbeResult(result);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "Probe failed");
    } finally {
      setProbing(false);
    }
  }

  function toggleContentType(ct: ContentType) {
    setContentTypes((prev) => (prev.includes(ct) ? prev.filter((c) => c !== ct) : [...prev, ct]));
  }

  const runDisabled =
    !ackPermission || contentTypes.length === 0 || !probeResult?.ok || probeResult.robots.allowed === false;

  async function handleRun() {
    setSubmitting(true);
    setRunError(null);
    try {
      const { job: created } = await createJob({
        url: url.trim(),
        scope,
        contentTypes,
        ackPermission: true,
      });
      setActiveJobId(created.id);
      setDrawerTab("log");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start crawl";
      const retryAfter = (err as { retryAfterSeconds?: number })?.retryAfterSeconds;
      setRunError(retryAfter ? `${message} (retry in ${retryAfter}s)` : message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAbort() {
    if (!activeJobId) return;
    try {
      await abortJob(activeJobId);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to abort job");
    }
  }

  function handleSelectHistory(historyJob: CrawlJobRow) {
    setActiveJobId(historyJob.id);
    setUrl(historyJob.target_url);
    setScope(historyJob.scope);
    setContentTypes(historyJob.content_types);
    setDrawerTab("log");
  }

  function handleNewCrawl() {
    setActiveJobId(null);
    setProbeResult(null);
    setProbeError(null);
    setAckPermission(false);
    setRunError(null);
  }

  const isTerminal = job && ["completed", "failed", "aborted"].includes(job.status);

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl font-bold uppercase tracking-[0.15em] text-ac text-glow">
            CRAWLR
          </h1>
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-ac/40">
            static-html extraction · no ai · no re-hosting
          </span>
        </div>
        <div className="flex items-center gap-3">
          <StageRail state={uiState} hasProbe={Boolean(probeResult)} ackPermission={ackPermission} />
          <StatePill state={uiState} />
        </div>
      </header>

      {authError && (
        <div className="rounded-sm border border-danger/40 bg-danger/10 px-4 py-3 font-mono text-[11px] text-danger">
          <span className="font-semibold uppercase tracking-[0.2em]">Config error —</span> {authError}. Set{" "}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> and redeploy; the app
          cannot reach Supabase without them.
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
        <ControlRail
          url={url}
          onUrlChange={setUrl}
          onProbe={handleProbe}
          probing={probing}
          probeResult={probeResult}
          probeError={probeError}
          scope={scope}
          onScopeChange={setScope}
          contentTypes={contentTypes}
          onToggleContentType={toggleContentType}
          ackPermission={ackPermission}
          onAckPermissionChange={setAckPermission}
          onRun={handleRun}
          runDisabled={runDisabled}
          runError={runError}
          activeJob={job}
          onAbort={handleAbort}
          submitting={submitting}
        />

        <div className="flex flex-col gap-6">
          <LinkGraph job={job} events={events} />

          {isTerminal && job && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-ac/40">
                {jobLoading ? "loading…" : `job ${job.id.slice(0, 8)}`}
              </span>
              <Button variant="ghost" onClick={handleNewCrawl}>
                New crawl →
              </Button>
            </div>
          )}

          {isTerminal && job && <ResultPanel job={job} assets={assets} />}

          <div className="panel-glass crt-corner rounded-md p-4">
            <div className="mb-3 flex gap-4 border-b border-ac/10 pb-2 font-mono text-[11px] uppercase tracking-[0.2em]">
              <button
                type="button"
                onClick={() => setDrawerTab("log")}
                className={drawerTab === "log" ? "text-ac" : "text-ac/40 hover:text-ac/70"}
              >
                Event log
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab("history")}
                className={drawerTab === "history" ? "text-ac" : "text-ac/40 hover:text-ac/70"}
              >
                Run history
              </button>
            </div>
            {drawerTab === "log" ? (
              <EventLog events={events} />
            ) : (
              <RunHistoryDrawer
                jobs={history}
                loading={historyLoading}
                onSelect={handleSelectHistory}
                activeJobId={activeJobId}
              />
            )}
          </div>
        </div>
      </div>

      <footer className="border-t border-ac/10 pt-4 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-ac/25">
        static html only · robots.txt honored · no logins/paywalls/captcha bypass ·{" "}
        <a href="/about-crawlr" className="underline hover:text-ac/50">
          about crawlr
        </a>
      </footer>
    </main>
  );
}
