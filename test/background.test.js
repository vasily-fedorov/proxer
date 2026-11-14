import test from "node:test";
import assert from "node:assert/strict";
import { createChromeStub } from "./helpers/chrome-stub.js";

function createBackgroundChrome(initialConfig) {
  const stub = createChromeStub({ config: initialConfig });
  stub.tabUrl = "http://example.com/";
  const listeners = { clicked: [], command: [], auth: null, error: [], tabUpdated: [] };
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
  await import(`../background.js?fresh=${Math.random()}`);
  return env;
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
