import { parseErrorPageQuery } from "./lib/error-page.js";
import { describeProxyError } from "./lib/errors.js";
import { maskProxyEndpoint } from "./lib/proxy.js";
import { loadConfig } from "./store.js";

const heading = document.getElementById("error-heading");
const detail = document.getElementById("error-detail");
const endpointLine = document.getElementById("error-endpoint");
const retry = document.getElementById("retry");
const openOptions = document.getElementById("open-options");

async function main() {
  const { targetUrl, code } = parseErrorPageQuery(location.search);
  const config = await loadConfig();
  const endpoint = config.proxy ? maskProxyEndpoint(config.proxy) : "";
  const reason = describeProxyError(code, { endpoint });

  let host = "";
  if (targetUrl) {
    try {
      host = new URL(targetUrl).hostname;
    } catch {
      host = "";
    }
  }

  heading.textContent = host ? `Не удалось открыть ${host} через прокси` : "Не удалось открыть сайт через прокси";
  detail.textContent = reason ? reason.detail : "Причина неизвестна.";
  endpointLine.textContent = endpoint ? `Прокси: ${endpoint}` : "";

  retry.disabled = !targetUrl;
  retry.addEventListener("click", () => {
    if (targetUrl) location.replace(targetUrl);
  });

  openOptions.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

void main();
