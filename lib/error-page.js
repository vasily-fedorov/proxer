const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

export function parseErrorPageQuery(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const rawUrl = params.get("url") || "";

  let targetUrl = "";
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (SAFE_PROTOCOLS.has(parsed.protocol)) targetUrl = parsed.href;
    } catch {
      targetUrl = "";
    }
  }

  const rawCode = params.get("code") || "";
  const code = /^ERR_[A-Z0-9_]+$/.test(rawCode) ? rawCode : "";
  return { targetUrl, code };
}
