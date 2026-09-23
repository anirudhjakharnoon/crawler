"use client";

export function triggerDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function triggerBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface AssetListItem {
  asset_url: string;
  asset_type: string;
  alt_text?: string | null;
  mime_type?: string | null;
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function assetsToCsv(assets: AssetListItem[]): string {
  const header = ["url", "type", "alt_text", "mime_type"].join(",");
  const rows = assets.map((a) =>
    [a.asset_url, a.asset_type, a.alt_text ?? "", a.mime_type ?? ""].map(csvEscape).join(",")
  );
  return [header, ...rows].join("\n");
}

export function assetsToJson(assets: AssetListItem[]): string {
  return JSON.stringify(assets, null, 2);
}
