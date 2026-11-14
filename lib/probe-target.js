export const PROBE_MARKER = "proxer_probe";
export const PROBE_NEUTRAL_HOST = "example.com";

/**
 * Проверка идёт по HTTPS, потому что именно так работает реальный браузинг:
 * Chrome открывает туннель через CONNECT, а не посылает обычный HTTP-запрос.
 * Проверка по HTTP даёт ложные сбои на прокси, которые разрешают только 443.
 */
export function buildProbeUrls(domains, token) {
  const first = Array.isArray(domains) ? domains.find((domain) => typeof domain === "string" && domain) : "";
  const hosts = [];
  if (first) hosts.push(first);
  if (!hosts.includes(PROBE_NEUTRAL_HOST)) hosts.push(PROBE_NEUTRAL_HOST);

  return hosts.map((host) => {
    const url = new URL(`https://${host}/`);
    url.searchParams.set(PROBE_MARKER, token);
    return url.href;
  });
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

export function isProxyLevelCode(code) {
  return /^ERR_(PROXY|TUNNEL|SOCKS)_/.test(code);
}
