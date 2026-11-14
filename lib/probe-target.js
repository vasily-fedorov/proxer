export const PROBE_FALLBACK_URL = "http://example.com/";
export const PROBE_MARKER = "proxer_probe";

export function buildProbeUrl(domains, token) {
  const first = Array.isArray(domains) ? domains.find((domain) => typeof domain === "string" && domain) : "";
  const url = new URL(first ? `http://${first}/` : PROBE_FALLBACK_URL);
  url.searchParams.set(PROBE_MARKER, token);
  return url.href;
}

export function probeTokenFromUrl(url) {
  try {
    return new URL(url).searchParams.get(PROBE_MARKER) || "";
  } catch {
    return "";
  }
}

export function failureCodeFromName(name) {
  return name === "TimeoutError" ? "ERR_CONNECTION_TIMED_OUT" : "";
}
