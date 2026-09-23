/**
 * Registrable-domain ("eTLD+1") helpers, used to decide whether a discovered
 * link is "same site" for crawl-scope purposes, and to key the robots.txt
 * cache / rate limiter per domain. Backed by the Public Suffix List via
 * `psl` — a static data lookup, not a network call.
 */
import psl from "psl";

export function getRegistrableDomain(hostname: string): string {
  const normalized = hostname.toLowerCase();
  const parsed = psl.parse(normalized);
  if (parsed.error) {
    return normalized;
  }
  return parsed.domain ?? normalized;
}

export function isSameRegistrableDomain(hostnameA: string, hostnameB: string): boolean {
  return getRegistrableDomain(hostnameA) === getRegistrableDomain(hostnameB);
}

export function getRootDomain(url: URL): string {
  return getRegistrableDomain(url.hostname);
}
