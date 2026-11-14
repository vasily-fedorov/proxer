import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp } from "./cdp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const useHeadless = process.env.HEADLESS !== "0";

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function findChromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const cache = path.join(homedir(), ".cache", "ms-playwright");
  const entries = await readdir(cache).catch(() => []);
  const chromiumDirs = entries.filter((entry) => entry.startsWith("chromium-")).sort().reverse();

  for (const dir of chromiumDirs) {
    for (const sub of ["chrome-linux64", "chrome-linux"]) {
      const candidate = path.join(cache, dir, sub, "chrome");
      if (await exists(candidate)) return candidate;
    }
  }
  return "google-chrome";
}

const chromeBin = await findChromeBinary();

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

function pageServer(marker) {
  return http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body>${marker}</body></html>`);
  });
}

function proxyServer(marker, log, credentials = null) {
  const expected = credentials
    ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`
    : null;

  const server = http.createServer((req, res) => {
    const header = req.headers["proxy-authorization"] || "";

    if (expected && header !== expected) {
      log.push(`407 ${req.url}`);
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="proxer"', "content-type": "text/plain" });
      res.end("proxy auth required");
      return;
    }

    log.push(req.url);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body>${marker}</body></html>`);
  });
  server.on("connect", (req, socket) => {
    log.push(`CONNECT ${req.url}`);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  return server;
}

async function waitForDevToolsPort(profileDir, child) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome завершился с кодом ${child.exitCode}`);
    try {
      const [port] = (await readFile(file, "utf8")).split("\n");
      if (port) return Number(port);
    } catch {
      /* Chrome ещё пишет файл */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome не открыл DevTools-порт за 30 с");
}

async function fetchJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function extensionIdFromTargets(browser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos = [] } = await browser.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    const extensionTarget = targetInfos.find((info) => info.url?.startsWith("chrome-extension://"));
    if (extensionTarget) return new URL(extensionTarget.url).hostname;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "";
}

function unpackedExtensionId(directory) {
  const hash = createHash("sha256").update(directory).digest("hex").slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

async function resolveExtensionId(profileDir) {
  const fromProfile = await extensionIdFromProfile(profileDir).catch(() => "");
  return fromProfile || unpackedExtensionId(root);
}

async function extensionIdFromProfile(profileDir) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path.join(profileDir, "Default", "Preferences"), "utf8");
      const settings = JSON.parse(raw)?.extensions?.settings ?? {};
      for (const [id, value] of Object.entries(settings)) {
        if (value?.path && path.resolve(value.path) === root) return id;
      }
    } catch {
      /* профиль ещё пишется */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Не удалось определить id расширения ни через CDP, ни через Preferences");
}

async function openPage(browser, url, { waitForLoad = true } = {}) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);

  if (url && url !== "about:blank") {
    const loaded = waitForLoad ? browser.waitFor("Page.loadEventFired", sessionId, 20000) : null;
    await browser.send("Page.navigate", { url }, sessionId);
    if (loaded) await loaded;
  }
  return sessionId;
}

async function evaluate(browser, sessionId, expression) {
  const result = await browser.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`Ошибка в странице настроек: ${description}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitForText(browser, sessionId, expression, { timeout = 20000, label = "условие" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(browser, sessionId, expression).catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Не дождались: ${label}`);
}

async function main() {
  const upstream = pageServer("direct-ok");
  const upstreamPort = await listen(upstream);

  const proxyLog = [];
  const proxy = proxyServer("proxied-ok", proxyLog);
  const proxyPort = await listen(proxy);

  const authLog = [];
  const authProxy = proxyServer("auth-ok", authLog, { username: "proxer", password: "s3cret" });
  const authProxyPort = await listen(authProxy);

  const closedServer = pageServer("");
  const closedPort = await listen(closedServer);
  await closeServer(closedServer);

  const profileDir = await mkdtemp(path.join(tmpdir(), "proxer-e2e-"));
  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${root}`,
    `--disable-extensions-except=${root}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-debugging-port=0",
    "--host-resolver-rules=MAP target.test 127.0.0.1, MAP control.test 127.0.0.1"
  ];
  if (useHeadless) args.push("--headless=new");

  const child = spawn(chromeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let chromeStderr = "";
  child.stderr.on("data", (chunk) => {
    chromeStderr += chunk.toString();
  });

  let browser;
  try {
    const devToolsPort = await waitForDevToolsPort(profileDir, child);
    const version = await fetchJson(`http://127.0.0.1:${devToolsPort}/json/version`);
    browser = await Cdp.connect(version.webSocketDebuggerUrl);

    let extensionId = await resolveExtensionId(profileDir);
    if (!extensionId) extensionId = await extensionIdFromTargets(browser, 15000);

    const optionsSession = await openPage(browser, `chrome-extension://${extensionId}/options.html`);
    const optionsText = await evaluate(browser, optionsSession, "document.body.innerText");
    assert.match(optionsText, /Прокси-сервер/, "страница настроек не отрендерилась");

    const commands = await evaluate(
      browser,
      optionsSession,
      "(async () => (await chrome.commands.getAll()).map((c) => ({ name: c.name, shortcut: c.shortcut })))()"
    );
    const toggleCommand = commands.find((command) => command.name === "toggle-site");
    assert.ok(toggleCommand, "команда toggle-site не зарегистрирована");
    assert.ok(toggleCommand.shortcut, "у команды toggle-site нет горячей клавиши");

    const configure = (config) =>
      evaluate(
        browser,
        optionsSession,
        `(async () => {
           const { commitConfig } = await import("./store.js");
           const result = await commitConfig(${JSON.stringify(config)});
           if (!result.ok) throw new Error(result.error);
           return true;
         })()`
      );

    const workingProxy = {
      version: 1,
      proxy: { scheme: "http", host: "127.0.0.1", port: proxyPort, username: "", password: "" },
      domains: ["target.test"],
      lastError: null
    };
    await configure(workingProxy);

    const proxiedSession = await openPage(browser, `http://target.test:${upstreamPort}/`);
    const proxiedText = await evaluate(browser, proxiedSession, "document.body.innerText");
    assert.match(proxiedText, /proxied-ok/, `ожидали трафик через прокси, получили: ${proxiedText}`);
    assert.ok(
      proxyLog.some((entry) => entry.includes("target.test")),
      `прокси не видел target.test: ${JSON.stringify(proxyLog)}`
    );

    const directSession = await openPage(browser, `http://control.test:${upstreamPort}/`);
    const directText = await evaluate(browser, directSession, "document.body.innerText");
    assert.match(directText, /direct-ok/, `домен вне списка должен идти напрямую, получили: ${directText}`);
    assert.equal(
      proxyLog.some((entry) => entry.includes("control.test")),
      false,
      "домен вне списка попал в прокси"
    );

    const badgeFor = (host) =>
      evaluate(
        browser,
        optionsSession,
        `(async () => {
           const tabs = await chrome.tabs.query({});
           const tab = tabs.find((item) => (item.url || "").includes("${host}"));
           if (!tab) return "no-tab";
           return chrome.action.getBadgeText({ tabId: tab.id });
         })()`
      );

    assert.equal(await badgeFor("target.test"), "ON", "на покрытом сайте нет badge ON");
    assert.equal(await badgeFor("control.test"), "", "на непокрытом сайте badge не должен стоять");

    const fill = async (id, value) => {
      await evaluate(
        browser,
        optionsSession,
        `(() => {
           const el = document.getElementById(${JSON.stringify(id)});
           el.value = ${JSON.stringify(value)};
           el.dispatchEvent(new Event("input", { bubbles: true }));
           el.dispatchEvent(new Event("change", { bubbles: true }));
           return el.value;
         })()`
      );
    };

    const clickAndAwaitStatus = async (id, needle, timeout = 25000) => {
      await evaluate(browser, optionsSession, `document.getElementById(${JSON.stringify(id)}).click()`);
      return waitForText(
        browser,
        optionsSession,
        `(() => {
           const status = document.getElementById("proxy-status");
           return status.textContent.includes(${JSON.stringify(needle)}) ? status.textContent : "";
         })()`,
        { timeout, label: `статус «${needle}»` }
      );
    };

    const storedConfig = () =>
      evaluate(
        browser,
        optionsSession,
        `(async () => {
           const { loadConfig, invalidateConfigCache } = await import("./store.js");
           invalidateConfigCache();
           const config = await loadConfig();
           return { port: config.proxy ? config.proxy.port : null, domains: config.domains, error: config.lastError };
         })()`
      );

    await fill("address", `127.0.0.1:${proxyPort}`);
    const okStatus = await clickAndAwaitStatus("check-proxy", "Прокси доступен");
    assert.match(okStatus, new RegExp(`127\\.0\\.0\\.1:${proxyPort}`), `проверка не подтвердила прокси: ${okStatus}`);

    await fill("address", `127.0.0.1:${closedPort}`);
    const failStatus = await clickAndAwaitStatus("save-proxy", "Не сохранено");
    assert.match(failStatus, /не отвечает/i, `ожидали причину сбоя, получили: ${failStatus}`);

    const afterFail = await storedConfig();
    assert.equal(afterFail.port, proxyPort, `сохранение не должно было пройти, в конфиге порт ${afterFail.port}`);

    await fill("address", `127.0.0.1:${authProxyPort}`);
    await fill("username", "proxer");
    await fill("password", "s3cret");
    await clickAndAwaitStatus("save-proxy", "Прокси сохранён");

    const afterAuth = await storedConfig();
    assert.equal(afterAuth.port, authProxyPort, "прокси с авторизацией не сохранился");

    await configure({
      ...workingProxy,
      proxy: {
        scheme: "http",
        host: "127.0.0.1",
        port: authProxyPort,
        username: "proxer",
        password: "s3cret"
      }
    });

    const authSession = await openPage(browser, `http://target.test:${upstreamPort}/auth`);
    const authText = await evaluate(browser, authSession, "document.body.innerText");
    assert.match(authText, /auth-ok/, `прокси с авторизацией не пропустил запрос: ${authText}`);
    assert.ok(
      authLog.some((entry) => entry.startsWith("407 ")),
      `прокси не отправил 407: ${JSON.stringify(authLog)}`
    );
    assert.ok(
      authLog.some((entry) => entry.includes("/auth")),
      `повторный запрос с кредами не дошёл: ${JSON.stringify(authLog)}`
    );

    await configure({
      ...workingProxy,
      proxy: { ...workingProxy.proxy, port: closedPort }
    });

    const failSession = await openPage(browser, `http://target.test:${upstreamPort}/`, { waitForLoad: false });
    const href = await waitForText(browser, failSession, "location.href", {
      timeout: 25000,
      label: "переход на proxy-error.html"
    });
    assert.ok(
      href.startsWith(`chrome-extension://${extensionId}/proxy-error.html`),
      `вкладка не на странице сбоя: ${href}`
    );

    const endpointText = await waitForText(
      browser,
      failSession,
      "document.getElementById('error-endpoint').textContent",
      { timeout: 20000, label: "адрес прокси на странице сбоя" }
    );
    assert.match(endpointText, new RegExp(`127\\.0\\.0\\.1:${closedPort}`), `нет адреса прокси: ${endpointText}`);

    const errorText = await evaluate(browser, failSession, "document.body.innerText");
    assert.match(errorText, /Повторить/, "нет кнопки повтора");

    console.log("E2E OK");
  } catch (error) {
    if (chromeStderr) console.error(chromeStderr.split("\n").slice(-25).join("\n"));
    throw error;
  } finally {
    if (browser) await browser.send("Browser.close").catch(() => {});
    browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    await closeServer(upstream);
    await closeServer(proxy);
    await closeServer(authProxy);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

await main();
