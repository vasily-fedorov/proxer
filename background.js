import { findCoveringRule, normalizeDomain, toggleDomain } from "./lib/domains.js";
import { describeProxyError } from "./lib/errors.js";
import { maskProxyEndpoint } from "./lib/proxy.js";
import { applyConfig, commitConfig, invalidateConfigCache, loadConfig, recordError, STORAGE_KEY } from "./store.js";

const ERROR_PAGE = "proxy-error.html";
const GREEN = "#188038";
const RED = "#d93025";

const isHttpUrl = (value) => typeof value === "string" && /^https?:\/\//i.test(value);

export function hostFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return normalizeDomain(hostname) || hostname;
  } catch {
    return "";
  }
}

export async function updateBadge(tab) {
  if (!tab || typeof tab.id !== "number") return;

  if (!isHttpUrl(tab.url)) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    return;
  }

  const host = hostFromUrl(tab.url);
  const config = await loadConfig();
  const rule = findCoveringRule(config.domains, host);

  if (rule) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: GREEN });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: `Прокси включён: ${host} → ${maskProxyEndpoint(config.proxy)} (правило ${rule})`
    });
    return;
  }

  await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  await chrome.action.setTitle({ tabId: tab.id, title: "Сайт идёт напрямую — нажмите, чтобы включить прокси" });
}

export async function handleToggle(tab) {
  if (!tab || typeof tab.id !== "number" || !isHttpUrl(tab.url)) return { ok: false, error: "unsupported-url" };

  const host = hostFromUrl(tab.url);
  if (!host) return { ok: false, error: "unsupported-url" };

  const config = await loadConfig();
  const wasCovered = Boolean(findCoveringRule(config.domains, host));
  const result = await commitConfig({ ...config, domains: toggleDomain(config.domains, host) });

  if (!result.ok) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: RED });
    return { ok: false, error: result.error };
  }

  await chrome.tabs.reload(tab.id);
  return { ok: true, proxied: !wasCovered };
}

export async function handleProxyFailure(details) {
  if (!details || details.tabId < 0 || details.type !== "main_frame") return false;

  const config = await loadConfig();
  if (!config.proxy) return false;

  const reason = describeProxyError(details.error, { endpoint: maskProxyEndpoint(config.proxy) });
  if (!reason) return false;

  const host = hostFromUrl(details.url);
  if (!host || !findCoveringRule(config.domains, host)) return false;

  let tab;
  try {
    tab = await chrome.tabs.get(details.tabId);
  } catch {
    return false;
  }
  if (!tab || !isHttpUrl(tab.url)) return false;

  await chrome.action.setBadgeText({ tabId: details.tabId, text: "!" });
  await chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: RED });

  const params = new URLSearchParams({ url: details.url, code: reason.code });
  await chrome.tabs.update(details.tabId, { url: `${chrome.runtime.getURL(ERROR_PAGE)}?${params.toString()}` });
  return true;
}

chrome.action.onClicked.addListener((tab) => handleToggle(tab));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-site") return undefined;
  return (async () => {
    const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (target) await handleToggle(target);
  })();
});

chrome.webRequest.onAuthRequired.addListener(
  async (details, callback) => {
    const config = await loadConfig();
    const proxy = config.proxy;
    const host = hostFromUrl(details.url);
    const covered = Boolean(host && findCoveringRule(config.domains, host));

    if (details.isProxy && covered && proxy && proxy.scheme === "http" && proxy.username) {
      callback({ authCredentials: { username: proxy.username, password: proxy.password } });
      return;
    }
    callback({});
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => handleProxyFailure(details),
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.type !== "main_frame" || details.tabId < 0) return;
    try {
      const tab = await chrome.tabs.get(details.tabId);
      if (tab) await updateBadge(tab);
    } catch {
      /* вкладка уже закрыта */
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await updateBadge(await chrome.tabs.get(tabId));
  } catch {
    /* вкладка уже закрыта */
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") void updateBadge(tab);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  invalidateConfigCache();
  void (async () => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) await updateBadge(tab);
  })();
});

chrome.proxy.onProxyError.addListener((details) => {
  if (!details || !details.fatal) return;
  const suffix = details.details ? ` — ${details.details}` : "";
  void recordError(`PAC: ${details.error}${suffix}`);
});

async function bootstrap() {
  const config = await loadConfig();
  const result = await applyConfig(config);
  if (result.error) await recordError(result.error);
}

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});
