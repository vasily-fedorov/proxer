import { domainFromInput } from "./lib/domains.js";
import { buildProxyPatch } from "./lib/options-model.js";
import { formatProxyEndpoint, maskProxyEndpoint } from "./lib/proxy.js";
import { commitConfig, getProxyControl, loadConfig } from "./store.js";

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

function renderList() {
  domainList.textContent = "";
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

$("save-proxy").addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  const existingPassword = config.proxy ? config.proxy.password : "";
  const patch = buildProxyPatch(config, {
    scheme: schemeSelect.value,
    address: addressInput.value,
    username,
    password: username ? passwordInput.value || existingPassword : ""
  });

  if (!patch.ok) {
    setStatus(proxyStatus, patch.error, true);
    return;
  }

  const result = await commitConfig(patch.config);
  config = result.config;
  render();
  setStatus(proxyStatus, result.ok ? patch.notice || "Прокси сохранён" : result.error, !result.ok);
  await renderControl();
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
  await renderControl();
}

void main();
