import test from "node:test";
import assert from "node:assert/strict";
import { buildProxyPatch } from "../lib/options-model.js";

const base = { version: 1, proxy: null, domains: ["example.com"], lastError: "старое" };

test("buildProxyPatch сохраняет разобранный прокси и чистит lastError", () => {
  const result = buildProxyPatch(base, { scheme: "http", address: "1.2.3.4:8080", username: "", password: "" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.proxy, {
    scheme: "http",
    host: "1.2.3.4",
    port: 8080,
    username: "",
    password: ""
  });
  assert.equal(result.config.lastError, null);
  assert.deepEqual(result.config.domains, ["example.com"]);
});

test("buildProxyPatch переносит креды из адреса", () => {
  const result = buildProxyPatch(base, { scheme: "http", address: "u:p@1.2.3.4:8080", username: "", password: "" });
  assert.equal(result.ok, true);
  assert.equal(result.config.proxy.username, "u");
  assert.match(result.notice, /из адреса/);
});

test("buildProxyPatch возвращает ошибку валидации без изменения конфига", () => {
  const result = buildProxyPatch(base, { scheme: "http", address: "1.2.3.4", username: "", password: "" });
  assert.equal(result.ok, false);
  assert.match(result.error, /порт/i);
  assert.equal(result.config, undefined);
});

test("buildProxyPatch отклоняет креды для SOCKS5", () => {
  const result = buildProxyPatch(base, { scheme: "socks5", address: "1.2.3.4:1080", username: "u", password: "p" });
  assert.equal(result.ok, false);
  assert.match(result.error, /SOCKS5/);
});
