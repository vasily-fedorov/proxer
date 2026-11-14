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

const probeCandidate = { scheme: "http", host: "10.0.0.9", port: 3128, username: "", password: "" };

function stubFetch(outcome) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (typeof outcome === "function") return outcome(url, calls.length);
    if (outcome instanceof Error) throw outcome;
    return { ok: true, type: "opaque" };
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

test("probeProxy проверяет первый сайт по HTTPS через fixed_servers и восстанавливает PAC", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  const fetcher = stubFetch(null);
  try {
    const result = await env.mod.probeProxy(probeCandidate);

    assert.equal(result.ok, true);
    assert.equal(result.endpoint, "10.0.0.9:3128");
    assert.match(fetcher.calls[0].url, /^https:\/\/target\.test\/\?proxer_probe=/);

    const [fixed, restored] = env.stub.calls.set;
    assert.equal(fixed.value.mode, "fixed_servers");
    assert.deepEqual(fixed.value.rules.singleProxy, { scheme: "http", host: "10.0.0.9", port: 3128 });
    assert.equal(restored.value.mode, "pac_script");

    assert.equal(env.mod.isProbeActive(), false);
    assert.equal(env.stub.storage.has("probe"), false);
  } finally {
    fetcher.restore();
  }
});

test("probeProxy падает на закрытом прокси и возвращает PAC обратно", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  const fetcher = stubFetch(() => {
    env.mod.recordProbeError({ url: "https://target.test/?proxer_probe=", error: "net::ERR_PROXY_CONNECTION_FAILED" });
    throw new TypeError("Failed to fetch");
  });
  try {
    const result = await env.mod.probeProxy(probeCandidate);

    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_PROXY_CONNECTION_FAILED");
    assert.match(result.reason.detail, /10\.0\.0\.9:3128/);

    const last = env.stub.calls.set.at(-1);
    assert.equal(last.value.mode, "pac_script");
  } finally {
    fetcher.restore();
  }
});

test("probeProxy ловит ошибку по хосту даже если redirect потерял маркер", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  const fetcher = stubFetch(() => {
    env.mod.recordProbeError({ url: "https://www.target.test/", error: "net::ERR_TUNNEL_CONNECTION_FAILED" });
    throw new TypeError("Failed to fetch");
  });
  try {
    const result = await env.mod.probeProxy(probeCandidate);
    assert.equal(result.code, "ERR_TUNNEL_CONNECTION_FAILED");
  } finally {
    fetcher.restore();
  }
});

test("probeProxy переходит на нейтральный хост, если сайт из списка не отвечает", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["broken.test"], lastError: null });
  let call = 0;
  const fetcher = stubFetch(() => {
    call += 1;
    if (call === 1) {
      env.mod.recordProbeError({ url: "https://broken.test/?proxer_probe=x", error: "net::ERR_CERT_AUTHORITY_INVALID" });
      throw new TypeError("Failed to fetch");
    }
    return { ok: true, type: "opaque" };
  });
  try {
    const result = await env.mod.probeProxy(probeCandidate);
    assert.equal(result.ok, true);
    assert.match(fetcher.calls[0].url, /broken\.test/);
    assert.match(fetcher.calls[1].url, /example\.com/);
  } finally {
    fetcher.restore();
  }
});

test("probeProxy не пытается обойти сбой прокси вторым хостом", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  const fetcher = stubFetch(() => {
    env.mod.recordProbeError({ url: "https://target.test/?proxer_probe=x", error: "net::ERR_PROXY_CONNECTION_FAILED" });
    throw new TypeError("Failed to fetch");
  });
  try {
    const result = await env.mod.probeProxy(probeCandidate);
    assert.equal(result.ok, false);
    assert.equal(fetcher.calls.length, 1, "после сбоя прокси второй хост не нужен");
  } finally {
    fetcher.restore();
  }
});

test("probeProxy переводит таймаут в понятную причину", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  const fetcher = stubFetch(() => {
    const error = new Error("timeout");
    error.name = "TimeoutError";
    throw error;
  });
  try {
    const result = await env.mod.probeProxy(probeCandidate);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_CONNECTION_TIMED_OUT");
    assert.match(result.reason.title, /не ответил/i);
  } finally {
    fetcher.restore();
  }
});

test("probeProxy отклоняет некорректный прокси и не трогает настройки браузера", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  const result = await env.mod.probeProxy({ scheme: "socks5", host: "10.0.0.9", port: 1080, username: "u", password: "p" });

  assert.equal(result.ok, false);
  assert.match(result.reason.detail, /SOCKS5/);
  assert.equal(env.stub.calls.set.length, 0);
});

test("probeProxy не запускает вторую проверку параллельно", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  let release;
  const fetcher = stubFetch(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
  try {
    const running = env.mod.probeProxy(probeCandidate);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await env.mod.probeProxy(probeCandidate);
    assert.equal(second.ok, false);
    assert.match(second.reason.title, /уже идёт/);

    release();
    assert.equal((await running).ok, true);
  } finally {
    fetcher.restore();
  }
});

test("во время проверки onAuthRequired отдаёт креды проверяемого прокси", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  let release;
  const fetcher = stubFetch(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
  try {
    const running = env.mod.probeProxy({ ...probeCandidate, username: "probe-user", password: "probe-pass" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ask = (details) => new Promise((resolve) => env.listeners.auth.fn(details, resolve));
    assert.deepEqual(await ask({ isProxy: true, url: "https://target.test/" }), {
      authCredentials: { username: "probe-user", password: "probe-pass" }
    });

    release();
    await running;
    assert.deepEqual(await ask({ isProxy: true, url: "https://target.test/" }), {});
  } finally {
    fetcher.restore();
  }
});

test("во время проверки сбои других вкладок не уводят их на страницу ошибки", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["example.com"], lastError: null });
  let release;
  const fetcher = stubFetch(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
  try {
    const running = env.mod.probeProxy(probeCandidate);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await env.listeners.error[0]({
      tabId: 5,
      type: "main_frame",
      url: "https://example.com/",
      error: "net::ERR_PROXY_CONNECTION_FAILED"
    });
    assert.equal(env.updates.length, 0);

    release();
    await running;

    await env.listeners.error[0]({
      tabId: 5,
      type: "main_frame",
      url: "https://example.com/",
      error: "net::ERR_PROXY_CONNECTION_FAILED"
    });
    assert.equal(env.updates.length, 1);
  } finally {
    fetcher.restore();
  }
});

test("onMessage обрабатывает только сообщение probe", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["target.test"], lastError: null });
  const fetcher = stubFetch(null);
  try {
    const response = await new Promise((resolve) =>
      env.listeners.message({ type: "probe", proxy: probeCandidate }, {}, resolve)
    );
    assert.equal(response.ok, true);
    assert.equal(env.listeners.message({ type: "unknown" }, {}, () => {}), false);
  } finally {
    fetcher.restore();
  }
});

test("handleToggle включает домен вместе с профилем популярного сайта", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: [], lastError: null });
  await env.listeners.clicked[0]({ id: 9, url: "https://www.youtube.com/watch?v=1" });

  const stored = env.stub.storage.get("config");
  assert.ok(stored.domains.includes("youtube.com"), "сам сайт должен быть в списке");
  assert.ok(stored.domains.includes("googlevideo.com"), "медиа-домен профиля должен добавиться");
  assert.ok(stored.domains.includes("ytimg.com"), "CDN картинок должен добавиться");
  assert.deepEqual(stored.domains, [...stored.domains].sort());
});

test("handleToggle выключает сайт и убирает домены профиля", async () => {
  const env = await loadBackground({
    version: 1,
    proxy,
    domains: ["youtube.com", "googlevideo.com", "ytimg.com", "other.org"],
    lastError: null
  });
  await env.listeners.clicked[0]({ id: 9, url: "https://youtube.com/" });

  const stored = env.stub.storage.get("config");
  assert.deepEqual(stored.domains, ["other.org"]);
});

test("для сайта без профиля toggle остаётся прежним", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: [], lastError: null });
  await env.listeners.clicked[0]({ id: 2, url: "https://example.com/page" });

  assert.deepEqual(env.stub.storage.get("config").domains, ["example.com"]);
});

test("recordSuggestion запоминает чужой домен, который грузится напрямую", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["youtube.com"], lastError: null });
  const added = await env.mod.recordSuggestion({
    type: "media",
    tabId: 3,
    url: "https://rr4---sn-4g5e6nzs.googlevideo.com/videoplayback",
    initiator: "https://www.youtube.com",
    error: "net::ERR_CONNECTION_RESET"
  });

  assert.equal(added, true);
  assert.deepEqual(env.stub.session.get("suggestions"), [{ site: "youtube.com", domain: "googlevideo.com" }]);
});

test("recordSuggestion игнорирует main_frame, чужие страницы и шумные коды", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["youtube.com", "ytimg.com"], lastError: null });
  const base = {
    type: "image",
    tabId: 3,
    url: "https://cdn.other.com/x.png",
    initiator: "https://www.youtube.com",
    error: "net::ERR_CONNECTION_RESET"
  };

  assert.equal(await env.mod.recordSuggestion({ ...base, type: "main_frame" }), false);
  assert.equal(await env.mod.recordSuggestion({ ...base, initiator: "https://uncovered.example" }), false);
  assert.equal(await env.mod.recordSuggestion({ ...base, error: "net::ERR_ABORTED" }), false);
  assert.equal(await env.mod.recordSuggestion({ ...base, url: "https://ytimg.com/x.png", error: "net::ERR_CONNECTION_RESET" }), false);
  assert.deepEqual(env.stub.session.get("suggestions"), undefined);
});

test("recordSuggestion молчит, когда прокси не настроен", async () => {
  const env = await loadBackground({ version: 1, proxy: null, domains: ["youtube.com"], lastError: null });
  assert.equal(
    await env.mod.recordSuggestion({
      type: "image",
      tabId: 3,
      url: "https://cdn.other.com/x.png",
      initiator: "https://www.youtube.com",
      error: "net::ERR_CONNECTION_RESET"
    }),
    false
  );
});

test("badge показывает +N, когда часть доменов идёт напрямую", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["youtube.com"], lastError: null });
  await env.mod.recordSuggestion({
    type: "media",
    tabId: 7,
    url: "https://rr4.googlevideo.com/videoplayback",
    initiator: "https://www.youtube.com",
    error: "net::ERR_CONNECTION_RESET"
  });
  await env.mod.recordSuggestion({
    type: "image",
    tabId: 7,
    url: "https://i.ytimg.com/vi/1.jpg",
    initiator: "https://www.youtube.com",
    error: "net::ERR_CONNECTION_RESET"
  });

  await env.listeners.tabUpdated[0](7, { status: "complete" }, { id: 7, url: "https://www.youtube.com/watch" });

  const texts = env.badges.filter((badge) => badge.type === "text" && badge.tabId === 7);
  assert.equal(texts.at(-1).text, "+2");
  const colors = env.badges.filter((badge) => badge.type === "color" && badge.tabId === 7);
  assert.equal(colors.at(-1).color, "#f29900");
});

test("applySuggestion добавляет домен в конфиг и убирает подсказку", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["youtube.com"], lastError: null });
  await env.mod.recordSuggestion({
    type: "media",
    tabId: 3,
    url: "https://rr4.googlevideo.com/x",
    initiator: "https://www.youtube.com",
    error: "net::ERR_CONNECTION_RESET"
  });

  const result = await env.mod.applySuggestion({ site: "youtube.com", domain: "googlevideo.com" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.suggestions, []);

  const stored = env.stub.storage.get("config");
  assert.ok(stored.domains.includes("googlevideo.com"));
  assert.equal(env.stub.calls.set.at(-1).value.mode, "pac_script");
});

test("ignoreSuggestion убирает подсказку, не меняя конфиг", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["youtube.com"], lastError: null });
  await env.mod.recordSuggestion({
    type: "image",
    tabId: 3,
    url: "https://i.ytimg.com/x.png",
    initiator: "https://www.youtube.com",
    error: "net::ERR_CONNECTION_RESET"
  });

  const result = await env.mod.ignoreSuggestion({ site: "youtube.com", domain: "ytimg.com" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.suggestions, []);
  assert.deepEqual(env.stub.storage.get("config").domains, ["youtube.com"]);
});

test("сообщения suggestions-list, suggestion-apply и suggestion-ignore работают", async () => {
  const env = await loadBackground({ version: 1, proxy, domains: ["youtube.com"], lastError: null });
  await env.mod.recordSuggestion({
    type: "image",
    tabId: 3,
    url: "https://i.ytimg.com/x.png",
    initiator: "https://www.youtube.com",
    error: "net::ERR_CONNECTION_RESET"
  });

  const ask = (message) => new Promise((resolve) => env.listeners.message(message, {}, resolve));

  const listed = await ask({ type: "suggestions-list" });
  assert.equal(listed.ok, true);
  assert.equal(listed.suggestions.length, 1);

  const applied = await ask({ type: "suggestion-apply", site: "youtube.com", domain: "ytimg.com" });
  assert.equal(applied.ok, true);

  await env.mod.recordSuggestion({
    type: "image",
    tabId: 3,
    url: "https://i.ytimg.com/x.png",
    initiator: "https://www.youtube.com",
    error: "net::ERR_CONNECTION_RESET"
  }).catch(() => {});

  const ignored = await ask({ type: "suggestion-ignore", site: "youtube.com", domain: "ytimg.com" });
  assert.equal(ignored.ok, true);
  assert.equal(env.listeners.message({ type: "unknown" }, {}, () => {}), false);
});
