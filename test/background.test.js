import test from "node:test";
import assert from "node:assert/strict";
import { createChromeStub } from "./helpers/chrome-stub.js";

function createBackgroundChrome(initialConfig) {
  const stub = createChromeStub({ config: initialConfig });
  stub.tabUrl = "http://example.com/";
  const listeners = { clicked: [], command: [], auth: null, error: [], tabUpdated: [], message: null };
  const badges = [];
  const reloads = [];
  const updates = [];

  Object.assign(stub.chrome, {
    action: {
      onClicked: { addListener: (fn) => listeners.clicked.push(fn) },
      setBadgeText: async (payload) => badges.push({ type: "text", ...payload }),
      setBadgeBackgroundColor: async (payload) => badges.push({ type: "color", ...payload }),
      setTitle: async (payload) => badges.push({ type: "title", ...payload })
    },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
    tabs: {
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
      async reload(tabId) {
        reloads.push(tabId);
      },
      async get(tabId) {
        return { id: tabId, url: stub.tabUrl };
      },
      async query() {
        return [];
      },
      async update(tabId, props) {
        updates.push({ tabId, props });
      }
    },
    webRequest: {
      onAuthRequired: { addListener: (fn, filter, extra) => (listeners.auth = { fn, filter, extra }) },
      onErrorOccurred: { addListener: (fn) => listeners.error.push(fn) },
      onCompleted: { addListener: () => {} }
    },
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (fn) => (listeners.message = fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} }
    },
    proxy: {
      ...stub.chrome.proxy,
      onProxyError: { addListener: () => {} }
    },
    storage: {
      ...stub.chrome.storage,
      onChanged: { addListener: () => {} }
    }
  });

  return { stub, listeners, badges, reloads, updates };
}

async function loadBackground(config) {
  const store = await import("../store.js");
  store.invalidateConfigCache();

  const env = createBackgroundChrome(config);
  globalThis.chrome = env.stub.chrome;
  const mod = await import(`../background.js?fresh=${Math.random()}`);
  return { ...env, mod };
}

const proxy = { scheme: "http", host: "1.2.3.4", port: 8080, username: "", password: "" };

test("service worker регистрирует обработчики на верхнем уровне", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: [], lastError: null });
  assert.equal(env.listeners.clicked.length, 1);
  assert.equal(env.listeners.command.length, 1);
  assert.ok(env.listeners.auth, "onAuthRequired не зарегистрирован");
  assert.deepEqual(env.listeners.auth.extra, ["asyncBlocking"]);
  assert.deepEqual(env.listeners.auth.filter, { urls: ["<all_urls>"] });
});

test("handleToggle добавляет домен, применяет PAC и перезагружает вкладку", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: [], lastError: null });
  await env.listeners.clicked[0]({ id: 7, url: "https://www.example.com/page" });

  const stored = env.stub.storage.get("config");
  assert.deepEqual(stored.domains, ["example.com"]);
  assert.equal(env.stub.calls.set.length, 1);
  assert.deepEqual(env.reloads, [7]);
});

test("handleToggle снимает покрывающее правило при повторном клике", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  await env.listeners.clicked[0]({ id: 3, url: "https://a.example.com/" });

  const stored = env.stub.storage.get("config");
  assert.deepEqual(stored.domains, []);
  assert.equal(env.stub.calls.clear.length, 1);
});

test("handleToggle игнорирует не-http вкладки", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: [], lastError: null });
  await env.listeners.clicked[0]({ id: 4, url: "chrome://settings/" });
  assert.equal(env.reloads.length, 0);
  assert.equal(env.stub.calls.set.length, 0);
});

test("onAuthRequired отдаёт логин/пароль только для нашего прокси и покрытого хоста", async () => {
  const env = await loadBackground({
    version: 1,
    proxy: { ...proxy, username: "user", password: "s3cret" },
    domains: ["example.com"],
    lastError: null
  });

  const ask = (details) => new Promise((resolve) => env.listeners.auth.fn(details, resolve));

  assert.deepEqual(await ask({ isProxy: true, url: "https://example.com/" }), {
    authCredentials: { username: "user", password: "s3cret" }
  });
  assert.deepEqual(await ask({ isProxy: false, url: "https://example.com/" }), {});
  assert.deepEqual(await ask({ isProxy: true, url: "https://other.org/" }), {});
});

test("onErrorOccurred обрабатывает только main_frame покрытого хоста", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });

  await env.listeners.error[0]({ tabId: 5, type: "image", url: "https://example.com/", error: "net::ERR_PROXY_CONNECTION_FAILED" });
  assert.equal(env.updates.length, 0);

  await env.listeners.error[0]({ tabId: 5, type: "main_frame", url: "https://other.org/", error: "net::ERR_PROXY_CONNECTION_FAILED" });
  assert.equal(env.updates.length, 0);

  await env.listeners.error[0]({ tabId: 5, type: "main_frame", url: "https://example.com/", error: "net::ERR_NAME_NOT_RESOLVED" });
  assert.equal(env.updates.length, 0);

  await env.listeners.error[0]({ tabId: 5, type: "main_frame", url: "https://example.com/", error: "net::ERR_PROXY_CONNECTION_FAILED" });
  assert.equal(env.updates.length, 1);
  assert.match(env.updates[0].props.url, /^chrome-extension:\/\/test\/proxy-error\.html\?/);
  assert.match(env.updates[0].props.url, /ERR_PROXY_CONNECTION_FAILED/);
  assert.match(env.updates[0].props.url, /url=https%3A%2F%2Fexample\.com%2F/);
});

test("onErrorOccurred перенаправляет, даже если Chrome уже подменил URL вкладки на chrome-error", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  env.stub.tabUrl = "chrome-error://chromewebdata/";

  await env.listeners.error[0]({ tabId: 5, type: "main_frame", url: "https://example.com/", error: "net::ERR_PROXY_CONNECTION_FAILED" });
  assert.equal(env.updates.length, 1);
});

test("onErrorOccurred не зацикливается, если вкладка уже на странице сбоя", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  env.stub.tabUrl = "chrome-extension://test/proxy-error.html?url=https%3A%2F%2Fexample.com%2F&code=ERR_TIMED_OUT";

  await env.listeners.error[0]({ tabId: 5, type: "main_frame", url: "https://example.com/", error: "net::ERR_PROXY_CONNECTION_FAILED" });
  assert.equal(env.updates.length, 0);
});

test("badge не показывает ON, если домен в списке, а прокси не настроен", async () => {
  const env = await loadBackground({ version: 1, proxy: null, domains: ["example.com"], lastError: null });
  await env.listeners.tabUpdated[0](7, { status: "complete" }, { id: 7, url: "https://example.com/" });

  const texts = env.badges.filter((badge) => badge.type === "text" && badge.tabId === 7);
  assert.equal(texts.at(-1).text, "");

  const titles = env.badges.filter((badge) => badge.type === "title" && badge.tabId === 7);
  assert.match(titles.at(-1).title, /прокси не настроен/);
});

test("startProbe ставит fixed_servers на проверяемый прокси и возвращает цель", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  const result = await env.mod.startProbe({ scheme: "http", host: "10.0.0.9", port: 3128, username: "", password: "" });

  assert.equal(result.ok, true);
  assert.equal(result.endpoint, "10.0.0.9:3128");
  assert.match(result.url, /^http:\/\/target\.test\/\?proxer_probe=/);
  assert.equal(env.mod.isProbeActive(), true);

  const [call] = env.stub.calls.set;
  assert.equal(call.value.mode, "fixed_servers");
  assert.deepEqual(call.value.rules.singleProxy, { scheme: "http", host: "10.0.0.9", port: 3128 });
  assert.equal(env.stub.storage.get("probe"), result.token);
});

test("startProbe берёт example.com при пустом списке и socks5-схему", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: [], lastError: null });
  const result = await env.mod.startProbe({ scheme: "socks5", host: "10.0.0.9", port: 1080, username: "", password: "" });

  assert.equal(result.ok, true);
  assert.match(result.url, /^http:\/\/example\.com\/\?proxer_probe=/);
  const [call] = env.stub.calls.set;
  assert.equal(call.value.rules.singleProxy.scheme, "socks5");
});

test("startProbe отклоняет некорректный прокси и не трогает настройки браузера", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  const result = await env.mod.startProbe({ scheme: "socks5", host: "10.0.0.9", port: 1080, username: "u", password: "p" });

  assert.equal(result.ok, false);
  assert.match(result.reason.detail, /SOCKS5/);
  assert.equal(env.stub.calls.set.length, 0);
  assert.equal(env.mod.isProbeActive(), false);
});

test("startProbe не запускает вторую проверку параллельно", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  const candidate = { scheme: "http", host: "10.0.0.9", port: 3128, username: "", password: "" };

  assert.equal((await env.mod.startProbe(candidate)).ok, true);
  const second = await env.mod.startProbe(candidate);
  assert.equal(second.ok, false);
  assert.match(second.reason.title, /уже идёт/);
});

test("finishProbe при успехе возвращает PAC и снимает флаг", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  const started = await env.mod.startProbe({ scheme: "http", host: "10.0.0.9", port: 3128, username: "", password: "" });

  const result = await env.mod.finishProbe({ token: started.token, fetchFailed: false });
  assert.equal(result.ok, true);
  assert.equal(env.mod.isProbeActive(), false);

  const last = env.stub.calls.set.at(-1);
  assert.equal(last.value.mode, "pac_script");
  assert.equal(env.stub.storage.has("probe"), false);
});

test("finishProbe при провале отдаёт причину по коду из webRequest и возвращает PAC", async () => {
  const env = await loadBackground({
    version: 1,
    proxy: { ...proxy, username: "user", password: "s3cret" },
    domains: ["example.com"],
    lastError: null
  });
  const started = await env.mod.startProbe({ scheme: "http", host: "10.0.0.9", port: 3128, username: "user", password: "s3cret" });

  env.mod.recordProbeError({ url: started.url, error: "net::ERR_PROXY_CONNECTION_FAILED" });
  const result = await env.mod.finishProbe({ token: started.token, fetchFailed: true });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ERR_PROXY_CONNECTION_FAILED");
  assert.match(result.reason.detail, /10\.0\.0\.9:3128/);
  assert.equal(result.reason.detail.includes("s3cret"), false);

  const last = env.stub.calls.set.at(-1);
  assert.equal(last.value.mode, "pac_script");
});

test("recordProbeError игнорирует чужие URL", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  await env.mod.startProbe({ scheme: "http", host: "10.0.0.9", port: 3128, username: "", password: "" });

  env.mod.recordProbeError({ url: "https://example.com/", error: "net::ERR_PROXY_CONNECTION_FAILED" });
  const result = await env.mod.finishProbe({ token: "", fetchFailed: false });
  assert.equal(result.ok, true);
});

test("finishProbe переводит таймаут fetch в понятную причину", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  const started = await env.mod.startProbe({ scheme: "http", host: "10.0.0.9", port: 3128, username: "", password: "" });

  const result = await env.mod.finishProbe({ token: started.token, fetchFailed: true, failureName: "TimeoutError" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ERR_CONNECTION_TIMED_OUT");
  assert.match(result.reason.title, /не ответил/i);
});

test("во время проверки сбои других вкладок не уводят их на страницу ошибки", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  await env.mod.startProbe({ scheme: "http", host: "10.0.0.9", port: 3128, username: "", password: "" });

  await env.listeners.error[0]({
    tabId: 5,
    type: "main_frame",
    url: "https://example.com/",
    error: "net::ERR_PROXY_CONNECTION_FAILED"
  });
  assert.equal(env.updates.length, 0);

  await env.mod.finishProbe({ token: "", fetchFailed: false });
  await env.listeners.error[0]({
    tabId: 5,
    type: "main_frame",
    url: "https://example.com/",
    error: "net::ERR_PROXY_CONNECTION_FAILED"
  });
  assert.equal(env.updates.length, 1);
});

test("onMessage обрабатывает probe-start и probe-finish", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });

  const startResponse = await new Promise((resolve) =>
    env.listeners.message(
      { type: "probe-start", proxy: { scheme: "http", host: "10.0.0.9", port: 3128, username: "", password: "" } },
      {},
      resolve
    )
  );
  assert.equal(startResponse.ok, true);

  const finishResponse = await new Promise((resolve) =>
    env.listeners.message({ type: "probe-finish", token: startResponse.token, fetchFailed: false }, {}, resolve)
  );
  assert.equal(finishResponse.ok, true);
  assert.equal(env.listeners.message({ type: "unknown" }, {}, () => {}), false);
});

test("во время проверки onAuthRequired отдаёт креды проверяемого прокси", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  await env.mod.startProbe({ scheme: "http", host: "10.0.0.9", port: 3128, username: "probe-user", password: "probe-pass" });

  const ask = (details) => new Promise((resolve) => env.listeners.auth.fn(details, resolve));
  assert.deepEqual(await ask({ isProxy: true, url: "http://example.com/?proxer_probe=x" }), {
    authCredentials: { username: "probe-user", password: "probe-pass" }
  });

  await env.mod.finishProbe({ token: "", fetchFailed: false });

  assert.deepEqual(await ask({ isProxy: true, url: "http://example.com/" }), {});
});
