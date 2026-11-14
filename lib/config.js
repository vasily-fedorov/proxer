import { normalizeDomain } from "./domains.js";
import { validateProxy } from "./proxy.js";

export const DEFAULT_CONFIG = Object.freeze({ version: 1, proxy: null, domains: [], lastError: null });

function normalizeProxy(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.scheme !== "http" && raw.scheme !== "socks5") return null;

  const proxy = {
    scheme: raw.scheme,
    host: typeof raw.host === "string" ? raw.host.trim().toLowerCase() : "",
    port: Number(raw.port),
    username: typeof raw.username === "string" ? raw.username : "",
    password: typeof raw.password === "string" ? raw.password : ""
  };
  return validateProxy(proxy) ? null : proxy;
}

export function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG, domains: [] };

  const seen = new Set();
  const domains = [];
  for (const value of Array.isArray(raw.domains) ? raw.domains : []) {
    const domain = normalizeDomain(value);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  domains.sort();

  return {
    version: 1,
    proxy: normalizeProxy(raw.proxy),
    domains,
    lastError: typeof raw.lastError === "string" && raw.lastError ? raw.lastError : null
  };
}
