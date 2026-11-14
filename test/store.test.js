import test from "node:test";
import assert from "node:assert/strict";
import { createChromeStub } from "./helpers/chrome-stub.js";

const proxy = { scheme: "http", host: "1.2.3.4", port: 8080, username: "", password: "" };

let sequence = 0;
async function loadStore() {
  sequence += 1;
  return import(`../store.js?fresh=${sequence}`);
}

test("loadConfig возвращает дефолт при пустом хранилище", async () => {
  globalThis.chrome = createChromeStub().chrome;
  const { loadConfig } = await loadStore();
  const config = await loadConfig();
  assert.deepEqual(config.domains, []);
  assert.equal(config.proxy, null);
});

test("applyConfig с пустым списком снимает настройки через clear", async () => {
  const stub = createChromeStub();
  globalThis.chrome = stub.chrome;
  const { applyConfig } = await loadStore();
  const result = await applyConfig({ version: 1, proxy, domains: [], lastError: null });
  assert.equal(result.applied, false);
  assert.equal(result.error, null);
  assert.equal(stub.calls.clear.length, 1);
  assert.equal(stub.calls.clear[0].scope, "regular");
  assert.equal(stub.calls.set.length, 0);
});

test("applyConfig ставит PAC с mandatory и без пароля", async () => {
  const stub = createChromeStub();
  globalThis.chrome = stub.chrome;
  const { applyConfig } = await loadStore();
  const result = await applyConfig({
    version: 1,
    proxy: { ...proxy, username: "user", password: "s3cret" },
    domains: ["example.com"],
    lastError: null
  });
  assert.equal(result.applied, true);

  const [call] = stub.calls.set;
  assert.equal(call.value.mode, "pac_script");
  assert.equal(call.value.pacScript.mandatory, true);
  assert.match(call.value.pacScript.data, /PROXY 1\.2\.3\.4:8080/);
  assert.equal(call.value.pacScript.data.includes("s3cret"), false);
  assert.equal(call.scope, "regular");
});

test("applyConfig возвращает ошибку вместо исключения", async () => {
  const stub = createChromeStub();
  stub.failNextSet("Cannot set proxy");
  globalThis.chrome = stub.chrome;
  const { applyConfig } = await loadStore();
  const result = await applyConfig({ version: 1, proxy, domains: ["example.com"], lastError: null });
  assert.equal(result.applied, false);
  assert.match(result.error, /Cannot set proxy/);
});

test("commitConfig откатывается к предыдущему конфигу при ошибке применения", async () => {
  const stub = createChromeStub();
  globalThis.chrome = stub.chrome;
  const { commitConfig, loadConfig } = await loadStore();

  const first = await commitConfig({ version: 1, proxy, domains: ["example.com"], lastError: null });
  assert.equal(first.ok, true);

  stub.failNextSet("PAC rejected");
  const second = await commitConfig({ version: 1, proxy, domains: ["example.com", "other.org"], lastError: null });
  assert.equal(second.ok, false);
  assert.match(second.error, /PAC rejected/);
  assert.match(second.config.lastError, /PAC rejected/);
  assert.deepEqual(second.config.domains, ["example.com"]);

  const reloaded = await loadConfig();
  assert.deepEqual(reloaded.domains, ["example.com"]);
});

test("recordError пишет сообщение в конфиг", async () => {
  const stub = createChromeStub();
  globalThis.chrome = stub.chrome;
  const { recordError, loadConfig } = await loadStore();
  await recordError("PAC: boom");
  const config = await loadConfig();
  assert.equal(config.lastError, "PAC: boom");
});

test("getProxyControl сообщает уровень контроля Chrome", async () => {
  const stub = createChromeStub();
  stub.setLevelOfControl("controlled_by_this_extension");
  globalThis.chrome = stub.chrome;
  const { getProxyControl } = await loadStore();
  assert.equal(await getProxyControl(), "controlled_by_this_extension");
});
