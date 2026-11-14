import { findCoveringRule } from "./domains.js";

export const MAX_SUGGESTIONS_PER_SITE = 20;

/**
 * Двухуровневые публичные зоны: без них эвристика склеила бы cdn.example.co.uk
 * в "co.uk". Это не Public Suffix List, а короткий список частых случаев.
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "com.br", "com.au", "co.nz", "co.jp", "co.kr", "co.in", "co.za",
  "com.tr", "com.cn", "com.mx", "com.ar", "com.pl", "com.ua", "com.sg",
  "com.hk", "com.tw", "co.il", "co.id", "com.my", "com.ph", "com.vn"
]);

const IGNORED_CODES = new Set([
  "",
  "ERR_ABORTED",
  "ERR_BLOCKED_BY_CLIENT",
  "ERR_BLOCKED_BY_RESPONSE",
  "ERR_BLOCKED_BY_ADMINISTRATOR",
  "ERR_CACHE_MISS",
  "ERR_CACHE_READ_FAILURE",
  "ERR_CANCELED"
]);

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function registrableDomain(host) {
  const target = typeof host === "string" ? host.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!target) return "";
  if (target === "localhost" || target.includes(":") || IPV4_RE.test(target)) return target;

  const parts = target.split(".");
  if (parts.length <= 2) return target;

  const lastTwo = parts.slice(-2).join(".");
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

export function isIgnorableCode(rawCode) {
  const code = String(rawCode ?? "").replace(/^net::/, "");
  return IGNORED_CODES.has(code);
}

export function suggestionFor({ error, url, pageHost, domains }) {
  if (isIgnorableCode(error)) return null;
  if (typeof pageHost !== "string" || !pageHost) return null;
  if (!findCoveringRule(domains, pageHost)) return null;

  let targetHost;
  try {
    targetHost = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!targetHost) return null;

  const domain = registrableDomain(targetHost);
  if (!domain || domain === pageHost) return null;
  if (findCoveringRule(domains, targetHost)) return null;

  return domain;
}

export function addSuggestion(list, { site, domain }) {
  const current = Array.isArray(list) ? list : [];
  if (typeof site !== "string" || !site || typeof domain !== "string" || !domain) return current;

  const exists = current.some((item) => item.site === site && item.domain === domain);
  if (exists) return current;

  const siteCount = current.filter((item) => item.site === site).length;
  if (siteCount >= MAX_SUGGESTIONS_PER_SITE) return current;

  return [...current, { site, domain }];
}

export function pruneSuggestions(list, domains) {
  const current = Array.isArray(list) ? list : [];
  return current.filter((item) => !findCoveringRule(domains, item.domain));
}

export function suggestionCountFor(list, host) {
  const current = Array.isArray(list) ? list : [];
  return current.filter((item) => item.site === host || (host || "").endsWith(`.${item.site}`)).length;
}
