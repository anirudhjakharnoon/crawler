"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { ZIP_MAX_IMAGES } from "@/lib/constants";
import { downloadImagesZip, getFreshExportUrl } from "@/lib/client/api";
import { assetsToCsv, assetsToJson, triggerBlobDownload, triggerDownload } from "@/lib/client/exportLists";
import type { CrawlAssetRow, CrawlJobRow } from "@/lib/supabase/types";

export function ResultPanel({ job, assets }: { job: CrawlJobRow; assets: CrawlAssetRow[] }) {
  const [downloading, setDownloading] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const images = assets.filter((a) => a.asset_type === "image");
  const videos = assets.filter((a) => a.asset_type === "video");
  const embeds = assets.filter((a) => a.asset_type === "video_embed");

  const zipEligible = images.length > 0 && images.length <= ZIP_MAX_IMAGES;

  async function handleDownloadMarkdown() {
    setDownloading(true);
    setError(null);
    try {
      const { url } = await getFreshExportUrl(job.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to get export URL");
    } finally {
      setDownloading(false);
    }
  }

  async function handleZip() {
    setZipping(true);
    setError(null);
    try {
      const blob = await downloadImagesZip(job.id);
      triggerBlobDownload(`crawlr-${job.id}-images.zip`, blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to bundle images");
    } finally {
      setZipping(false);
    }
  }

  function handleCsv() {
    triggerDownload(`crawlr-${job.id}-assets.csv`, assetsToCsv(assets), "text/csv");
  }
  function handleJson() {
    triggerDownload(`crawlr-${job.id}-assets.json`, assetsToJson(assets), "application/json");
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        label="Export"
        actions={
          <span className="font-mono text-[10px] text-ac/40">
            {job.pages_crawled} pages · {(job.text_bytes / 1024).toFixed(1)}kb text
          </span>
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleDownloadMarkdown} disabled={!job.md_storage_path || downloading}>
            {downloading ? "Signing…" : "Download Markdown"}
          </Button>
          <Button variant="outline" onClick={handleCsv} disabled={assets.length === 0}>
            CSV list
          </Button>
          <Button variant="outline" onClick={handleJson} disabled={assets.length === 0}>
            JSON list
          </Button>
          {zipEligible && (
            <Button variant="outline" onClick={handleZip} disabled={zipping}>
              {zipping ? "Bundling…" : `Bundle ZIP (${images.length})`}
            </Button>
          )}
        </div>
        {error && <p className="mt-2 font-mono text-[11px] text-danger">✕ {error}</p>}
      </Panel>

      {images.length > 0 && (
        <Panel label={`Images (${images.length})`}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {images.map((img) => (
              <a
                key={img.id}
                href={img.asset_url}
                target="_blank"
                rel="noopener noreferrer"
                className="group relative aspect-square overflow-hidden rounded-sm border border-ac/10 bg-black/30"
                title={img.asset_url}
              >
                {/* Arbitrary external, crawl-target-supplied hosts — next/image's
                    remotePatterns can't be pre-configured for them, so a plain
                    <img> hotlinking straight to the source is the correct,
                    pragmatic choice here (also: we never re-host the bytes). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.asset_url}
                  alt={img.alt_text ?? ""}
                  loading="lazy"
                  className="h-full w-full object-cover opacity-90 transition-opacity duration-200 group-hover:opacity-100"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                  }}
                />
                <span className="absolute inset-0 border border-transparent transition-colors group-hover:border-ac/60" />
              </a>
            ))}
          </div>
        </Panel>
      )}

      {(videos.length > 0 || embeds.length > 0) && (
        <Panel label="Video">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ac/50">
                Direct download
              </h3>
              <ul className="space-y-1">
                {videos.map((v) => (
                  <li key={v.id}>
                    <a
                      href={v.asset_url}
                      download
                      className="break-all font-mono text-[11px] text-ac/70 underline underline-offset-2 hover:text-ac"
                    >
                      {v.asset_url}
                    </a>
                  </li>
                ))}
                {videos.length === 0 && <li className="font-mono text-[11px] text-ac/30">none found</li>}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ac/50">
                Open on source platform
              </h3>
              <ul className="space-y-1">
                {embeds.map((v) => (
                  <li key={v.id}>
                    <a
                      href={v.asset_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all font-mono text-[11px] text-ac/70 underline underline-offset-2 hover:text-ac"
                    >
                      {v.asset_url}
                    </a>
                  </li>
                ))}
                {embeds.length === 0 && <li className="font-mono text-[11px] text-ac/30">none found</li>}
              </ul>
              <p className="mt-2 text-[10px] text-ac/30">
                Embedded players are never re-hosted — platform ToS, not a technical limitation
                we&apos;re hiding.
              </p>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
