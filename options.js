import { domainFromInput } from "./lib/domains.js";
import { buildProxyPatch } from "./lib/options-model.js";
import { formatProxyEndpoint, maskProxyEndpoint } from "./lib/proxy.js";
import { commitConfig, getProxyControl, invalidateConfigCache, loadConfig } from "./store.js";

const $ = (id) => document.getElementById(id);

const schemeSelect = $("scheme");
const addressInput = $("address");
const usernameInput = $("username");
const passwordInput = $("password");
const socksHint = $("socks-hint");
const proxyStatus = $("proxy-status");
const domainInput = $("domain-input");
const domainStatus = $("domain-status");
const domainList = $("domain-list");
const suggestionList = $("suggestion-list");
const suggestionsHint = $("suggestions-hint");
const currentProxy = $("current-proxy");
const domainCount = $("domain-count");
const controlBanner = $("control-banner");
const errorBanner = $("error-banner");

let config = null;

function setStatus(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error", isError);
}

function syncSchemeFields() {
  const isSocks = schemeSelect.value === "socks5";
  usernameInput.disabled = isSocks;
  passwordInput.disabled = isSocks;
  socksHint.hidden = !isSocks;
  if (isSocks) {
    usernameInput.value = "";
    passwordInput.value = "";
  }
}

function renderList() {  domainList.textContent = "";
  if (config.domains.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Список пуст. Откройте сайт и нажмите на иконку Proxer.";
    domainList.append(empty);
    return;
  }

  for (const domain of config.domains) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = domain;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Удалить";
    remove.addEventListener("click", async () => {
      const next = config.domains.filter((value) => value !== domain);
      const result = await commitConfig({ ...config, domains: next });
      config = result.config;
      render();
      setStatus(domainStatus, result.ok ? `Удалён ${domain}` : result.error, !result.ok);
      await renderControl();
    });

    item.append(label, remove);
    domainList.append(item);
  }
}

let suggestions = [];

function renderSuggestions() {
  suggestionList.textContent = "";
  suggestionsHint.hidden = suggestions.length === 0;

  if (suggestions.length === 0) {
    return;
  }

  for (const { site, domain } of suggestions) {
    const item = document.createElement("li");

    const label = document.createElement("span");
    label.textContent = `${domain} — для ${site}`;

    const actions = document.createElement("span");
    actions.className = "actions";

    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Добавить";
    add.addEventListener("click", async () => {
      add.disabled = true;
      const response = await chrome.runtime.sendMessage({ type: "suggestion-apply", site, domain });
      if (response && response.ok) {
        suggestions = response.suggestions || [];
        invalidateConfigCache();
        config = await loadConfig();
        render();
        setStatus(domainStatus, `Добавлен ${domain}`);
      } else {
        add.disabled = false;
        setStatus(domainStatus, (response && response.error) || "Не удалось добавить домен", true);
      }
    });

    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "secondary";
    skip.textContent = "Игнорировать";
    skip.addEventListener("click", async () => {
      skip.disabled = true;
      const response = await chrome.runtime.sendMessage({ type: "suggestion-ignore", site, domain });
      suggestions = (response && response.suggestions) || [];
      renderSuggestions();
    });

    actions.append(add, skip);
    item.append(label, actions);
    suggestionList.append(item);
  }
}

async function loadSuggestions() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "suggestions-list" });
    suggestions = (response && response.suggestions) || [];
  } catch {
    suggestions = [];
  }
  renderSuggestions();
}

function render() {
  const proxy = config.proxy;
  addressInput.value = proxy ? formatProxyEndpoint(proxy) : "";
  schemeSelect.value = proxy ? proxy.scheme : "http";
  usernameInput.value = proxy ? proxy.username : "";
  passwordInput.value = "";
  passwordInput.placeholder = proxy && proxy.password ? "сохранён (оставьте пустым, чтобы не менять)" : "";
  syncSchemeFields();

  currentProxy.textContent = proxy ? maskProxyEndpoint(proxy) : "не настроен";
  domainCount.textContent = String(config.domains.length);

  errorBanner.hidden = !config.lastError;
  errorBanner.textContent = config.lastError || "";

  renderList();
  renderSuggestions();
}

async function renderControl() {
  const level = await getProxyControl();
  if (level === "controlled_by_this_extension" || level === "controllable_by_this_extension") {
    controlBanner.hidden = true;
    return;
  }
  controlBanner.hidden = false;
  controlBanner.textContent =
    level === "not_controllable" || level === "controlled_by_other_extensions"
      ? "Настройками прокси управляет политика или другое расширение — Proxer не сможет их применить."
      : `Настройки прокси сейчас контролируются извне (${level}).`;
}

schemeSelect.addEventListener("change", syncSchemeFields);

const saveProxyButton = $("save-proxy");
const checkProxyButton = $("check-proxy");

function formatReason(reason) {
  if (!reason) return "Причина неизвестна.";
  return reason.title ? `${reason.title}. ${reason.detail}` : reason.detail;
}

function setProbeBusy(busy) {
  saveProxyButton.disabled = busy;
  checkProxyButton.disabled = busy;
  if (busy) setStatus(proxyStatus, "Проверяю прокси…");
}

async function runProbe(candidate) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "probe", proxy: candidate });
  } catch (error) {
    return { ok: false, error: `Не удалось запустить проверку: ${error && error.message ? error.message : error}` };
  }

  if (response && response.ok) return { ok: true, endpoint: response.endpoint };
  return { ok: false, error: formatReason(response && response.reason), code: response && response.code };
}

function currentFormPatch() {
  const username = usernameInput.value.trim();
  const existingPassword = config.proxy ? config.proxy.password : "";
  return buildProxyPatch(config, {
    scheme: schemeSelect.value,
    address: addressInput.value,
    username,
    password: username ? passwordInput.value || existingPassword : ""
  });
}

saveProxyButton.addEventListener("click", async () => {
  const patch = currentFormPatch();
  if (!patch.ok) {
    setStatus(proxyStatus, patch.error, true);
    return;
  }

  setProbeBusy(true);
  let probe;
  try {
    probe = await runProbe(patch.config.proxy);
  } finally {
    setProbeBusy(false);
  }

  if (!probe.ok) {
    setStatus(proxyStatus, `Не сохранено: ${probe.error}`, true);
    return;
  }

  const result = await commitConfig(patch.config);
  config = result.config;
  render();
  setStatus(proxyStatus, result.ok ? patch.notice || "Прокси сохранён и доступен" : result.error, !result.ok);
  await renderControl();
});

checkProxyButton.addEventListener("click", async () => {
  const patch = currentFormPatch();
  if (!patch.ok) {
    setStatus(proxyStatus, patch.error, true);
    return;
  }

  setProbeBusy(true);
  let probe;
  try {
    probe = await runProbe(patch.config.proxy);
  } finally {
    setProbeBusy(false);
  }

  setStatus(
    proxyStatus,
    probe.ok ? `Прокси доступен: ${probe.endpoint}` : `Прокси недоступен: ${probe.error}`,
    !probe.ok
  );
});

$("add-domain").addEventListener("click", async () => {
  const domain = domainFromInput(domainInput.value);
  if (!domain) {
    setStatus(domainStatus, "Не удалось распознать домен", true);
    return;
  }
  if (config.domains.includes(domain)) {
    setStatus(domainStatus, "Такой сайт уже в списке", true);
    return;
  }

  const result = await commitConfig({ ...config, domains: [...config.domains, domain].sort() });
  config = result.config;
  domainInput.value = "";
  render();
  setStatus(domainStatus, result.ok ? `Добавлен ${domain}` : result.error, !result.ok);
  await renderControl();
});

async function main() {
  config = await loadConfig();
  render();
  await loadSuggestions();
  await renderControl();
}

chrome.storage.onChanged.addListener((changes, area) => {
  // Подсказки живут в storage.session и могут появиться, пока страница открыта:
  // без этой ветки блок не обновлялся до перезагрузки страницы.
  if (changes.suggestions) {
    suggestions = changes.suggestions.newValue || [];
    renderSuggestions();
  }

  if (area !== "local" || !changes.config) return;
  invalidateConfigCache();
  void (async () => {
    config = await loadConfig();
    render();
    await renderControl();
  })();
});

void main();
