import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProbeUrls,
  failureCodeFromName,
  isProxyLevelCode,
  probeTokenFromUrl,
  PROBE_NEUTRAL_HOST
} from "../lib/probe-target.js";

test("buildProbeUrls проверяет первый сайт по HTTPS, а не по HTTP", () => {
  const [first] = buildProbeUrls(["target.test", "other.org"], "tok-1");
  assert.equal(first, "https://target.test/?proxer_probe=tok-1");
  assert.equal(new URL(first).protocol, "https:");
  assert.equal(probeTokenFromUrl(first), "tok-1");
});

test("buildProbeUrls добавляет нейтральный хост вторым кандидатом", () => {
  const urls = buildProbeUrls(["target.test"], "t");
  assert.deepEqual(urls, ["https://target.test/?proxer_probe=t", `https://${PROBE_NEUTRAL_HOST}/?proxer_probe=t`]);
});

test("buildProbeUrls не дублирует нейтральный хост и работает с пустым списком", () => {
  assert.deepEqual(buildProbeUrls(["example.com"], "t"), ["https://example.com/?proxer_probe=t"]);
  assert.deepEqual(buildProbeUrls([], "t"), ["https://example.com/?proxer_probe=t"]);
  assert.deepEqual(buildProbeUrls(null, "t"), ["https://example.com/?proxer_probe=t"]);
});

test("buildProbeUrls пропускает мусорные записи списка", () => {
  assert.equal(buildProbeUrls(["", 42, "real.org"], "t")[0], "https://real.org/?proxer_probe=t");
});

test("probeTokenFromUrl не путает чужой URL с маркером", () => {
  assert.equal(probeTokenFromUrl("https://example.com/?proxer_probe=abc"), "abc");
  assert.equal(probeTokenFromUrl("https://example.com/"), "");
  assert.equal(probeTokenFromUrl("not a url"), "");
  assert.equal(probeTokenFromUrl("https://example.com/?proxer_probe="), "");
});

test("failureCodeFromName переводит таймаут в сетевой код", () => {
  assert.equal(failureCodeFromName("TimeoutError"), "ERR_CONNECTION_TIMED_OUT");
  assert.equal(failureCodeFromName("TypeError"), "");
  assert.equal(failureCodeFromName(""), "");
});

test("isProxyLevelCode отличает сбои прокси от сбоев сайта", () => {
  assert.equal(isProxyLevelCode("ERR_PROXY_CONNECTION_FAILED"), true);
  assert.equal(isProxyLevelCode("ERR_TUNNEL_CONNECTION_FAILED"), true);
  assert.equal(isProxyLevelCode("ERR_SOCKS_CONNECTION_FAILED"), true);
  assert.equal(isProxyLevelCode("ERR_SSL_PROTOCOL_ERROR"), false);
  assert.equal(isProxyLevelCode("ERR_CERT_AUTHORITY_INVALID"), false);
  assert.equal(isProxyLevelCode("ERR_CONNECTION_TIMED_OUT"), false);
  assert.equal(isProxyLevelCode(""), false);
});
