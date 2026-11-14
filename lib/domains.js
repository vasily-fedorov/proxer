const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);

export function normalizeDomain(input) {
  if (typeof input !== "string") return "";
  let host = input.trim().toLowerCase();
  if (!host) return "";
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost") return host;
  if (host.startsWith("www.") && host.slice(4).includes(".")) host = host.slice(4);
  return HOSTNAME_RE.test(host) ? host : "";
}

export function domainFromInput(input) {
  if (typeof input !== "string") return "";
  const text = input.trim();
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      return normalizeDomain(new URL(text).hostname);
    } catch {
      return "";
    }
  }
  return normalizeDomain(text.split(/[/?#]/)[0]);
}

export function findCoveringRule(domains, host) {
  const target = normalizeDomain(host) || String(host ?? "").trim().toLowerCase();
  if (!target || !Array.isArray(domains)) return null;

  let best = null;
  for (const rule of domains) {
    if (typeof rule !== "string" || !rule) continue;
    if (target === rule) return rule;
    if (target.endsWith(`.${rule}`) && (best === null || rule.length > best.length)) best = rule;
  }
  return best;
}

export function toggleDomain(domains, host) {
  const list = Array.isArray(domains) ? [...domains] : [];
  const target = normalizeDomain(host);
  if (!target) return list;

  const covering = findCoveringRule(list, target);
  if (covering) return list.filter((rule) => rule !== covering);
  if (list.includes(target)) return list;
  return [...list, target].sort();
}
