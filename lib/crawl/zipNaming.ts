/**
 * Derives a safe, unique-enough filename for a bundled image inside the
 * in-memory ZIP — never trusts the URL's path directly (path traversal,
 * missing/weird extensions, duplicate basenames across different pages).
 */

const SAFE_CHARS = /[^a-zA-Z0-9._-]/g;

export function buildZipEntryName(url: string, index: number): string {
  let base = `image-${index + 1}`;
  let ext = ".jpg";

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) {
      const dotIdx = last.lastIndexOf(".");
      if (dotIdx > 0 && dotIdx < last.length - 1) {
        const candidateExt = last.slice(dotIdx).toLowerCase().slice(0, 5);
        if (/^\.[a-z0-9]+$/.test(candidateExt)) ext = candidateExt;
        base = last.slice(0, dotIdx);
      } else {
        base = last;
      }
    }
  } catch {
    // keep defaults
  }

  const cleanedBase = base.replace(SAFE_CHARS, "_").slice(0, 60) || `image-${index + 1}`;
  return `${String(index + 1).padStart(3, "0")}-${cleanedBase}${ext}`;
}
