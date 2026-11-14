import { findCoveringRule, normalizeDomain, toggleDomain } from "./lib/domains.js";
import { describeProxyError, readErrorCode } from "./lib/errors.js";
import { maskProxyEndpoint, validateProxy } from "./lib/proxy.js";
import { buildProbeUrls, failureCodeFromName, isProxyLevelCode, probeTokenFromUrl } from "./lib/probe-target.js";
import { applyConfig, commitConfig, invalidateConfigCache, loadConfig, recordError, STORAGE_KEY } from "./store.js";

const ERROR_PAGE = "proxy-error.html";
const PROBE_KEY = "probe";
const PROBE_TIMEOUT_MS = 8000;
const GREEN = "#188038";
const RED = "#d93025";

let probeState = null;

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

  if (rule && !config.proxy) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: `Сайт ${host} в списке, но прокси не настроен — откройте настройки Proxer`
    });
    return;
  }

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
  if (probeState) return false;
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
  if (!tab) return false;

  const errorPageUrl = chrome.runtime.getURL(ERROR_PAGE);
  if (typeof tab.url === "string" && tab.url.startsWith(errorPageUrl)) return false;

  await chrome.action.setBadgeText({ tabId: details.tabId, text: "!" });
  await chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: RED });

  const params = new URLSearchParams({ url: details.url, code: reason.code });
  await chrome.tabs.update(details.tabId, { url: `${errorPageUrl}?${params.toString()}` });
  return true;
}

export function isProbeActive() {
  return probeState !== null;
}

function probeHostMatches(url) {
  if (!probeState) return false;
  if (probeTokenFromUrl(url) === probeState.token) return true;
  const host = hostFromUrl(url);
  return Boolean(host) && (host === probeState.host || host.endsWith("." + probeState.host));
}

export function recordProbeError(details) {
  if (!probeState || !details) return;
  if (!probeHostMatches(details.url)) return;
  const code = readErrorCode(details.error || "");
  if (!code) return;
  if (!probeState.errorCode || isProxyLevelCode(code)) probeState.errorCode = code;
}

function probeReason(code, endpoint) {
  const known = describeProxyError(code, { endpoint });
  if (known) return known;
  return {
    code: code || "ERR_PROXY_CONNECTION_FAILED",
    title: "Не удалось проверить прокси",
    detail: code
      ? `Запрос через прокси ${endpoint} завершился ошибкой ${code}.`
      : `Запрос через прокси ${endpoint} не удался.`
  };
}

async function restoreAfterProbe() {
  try {
    const config = await loadConfig();
    await applyConfig(config);
  } finally {
    await chrome.storage.local.remove(PROBE_KEY).catch(() => {});
    probeState = null;
  }
}

async function fetchProbeUrl(url, timeoutMs) {
  await fetch(url, {
    mode: "no-cors",
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(timeoutMs)
  });
}

/**
 * Проверяет доступ к прокси так же, как работает реальный браузинг: HTTPS через
 * CONNECT. Обычный HTTP-запрос даёт ложные сбои на прокси, разрешающих только 443.
 * Запрос выполняется в service worker: один вызов, без гонки между страницей и
 * воркером, с гарантированным восстановлением настроек в finally.
 */
export async function probeProxy(candidate, options = {}) {
  const validationError = validateProxy(candidate);
  if (validationError) {
    return { ok: false, reason: { code: "", title: "Прокси не проверен", detail: validationError } };
  }
  if (probeState) {
    return {
      ok: false,
      reason: { code: "", title: "Проверка уже идёт", detail: "Дождитесь окончания текущей проверки прокси." }
    };
  }

  const timeoutMs = Number(options.timeoutMs) || PROBE_TIMEOUT_MS;
  const config = await loadConfig();
  const token = crypto.randomUUID();
  const endpoint = maskProxyEndpoint(candidate);
  const urls = buildProbeUrls(config.domains, token);

  probeState = {
    token,
    host: hostFromUrl(urls[0]),
    errorCode: "",
    endpoint,
    proxy: candidate
  };

  try {
    await chrome.storage.local.set({ [PROBE_KEY]: token });
    await chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: { scheme: candidate.scheme, host: candidate.host, port: candidate.port },
          bypassList: []
        }
      },
      scope: "regular"
    });
  } catch (error) {
    await restoreAfterProbe();
    const message = error && error.message ? error.message : String(error);
    return { ok: false, reason: { code: "", title: "Не удалось включить прокси", detail: message } };
  }

  let code = "";
  let succeededUrl = "";

  try {
    for (const url of urls) {
      probeState.errorCode = "";
      probeState.host = hostFromUrl(url);
      try {
        await fetchProbeUrl(url, timeoutMs);
        succeededUrl = url;
        break;
      } catch (error) {
        const captured = readErrorCode(probeState.errorCode);
        const failureName = (error && error.name) || "";
        code = captured || failureCodeFromName(failureName) || "ERR_PROXY_CONNECTION_FAILED";
        if (isProxyLevelCode(code) && code !== "ERR_PROXY_AUTH_UNSUPPORTED") break;
      }
    }
  } finally {
    await restoreAfterProbe();
  }

  if (succeededUrl) return { ok: true, endpoint, url: succeededUrl, code: "" };
  return { ok: false, code, reason: probeReason(code, endpoint) };
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
    const candidate = probeState && probeState.proxy;
    if (details.isProxy && candidate && candidate.scheme === "http" && candidate.username) {
      const credentials = { username: candidate.username };
      credentials.password = candidate.password;
      callback({ authCredentials: credentials });
      return;
    }

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
  (details) => {
    recordProbeError(details);
    return handleProxyFailure(details);
  },
  { urls: ["<all_urls>"] }
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type !== "probe") return false;

  probeProxy(message.proxy, { timeoutMs: message.timeoutMs }).then(sendResponse, (error) =>
    sendResponse({ ok: false, reason: { code: "", title: "Проверка не выполнена", detail: String(error) } })
  );
  return true;
});

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
  if (changeInfo.status !== "complete") return undefined;
  return updateBadge(tab);
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
  const stored = await chrome.storage.local.get(PROBE_KEY).catch(() => ({}));
  if (stored && stored[PROBE_KEY]) {
    probeState = null;
    await chrome.storage.local.remove(PROBE_KEY).catch(() => {});
  }

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
