import test from "node:test";
import assert from "node:assert/strict";
import { buildProbeUrl, failureCodeFromName, probeTokenFromUrl, PROBE_FALLBACK_URL } from "../lib/probe-target.js";

test("buildProbeUrl проверяет первый сайт из списка", () => {
  const url = buildProbeUrl(["example.com", "other.org"], "tok-1");
  assert.equal(url, "http://example.com/?proxer_probe=tok-1");
  assert.equal(probeTokenFromUrl(url), "tok-1");
});

test("buildProbeUrl берёт fallback при пустом списке", () => {
  assert.equal(buildProbeUrl([], "t"), `http://example.com/?proxer_probe=t`);
  assert.equal(buildProbeUrl(null, "t"), `http://example.com/?proxer_probe=t`);
  assert.ok(PROBE_FALLBACK_URL.startsWith("http://"));
});

test("buildProbeUrl пропускает мусорные записи списка", () => {
  assert.equal(buildProbeUrl(["", 42, "real.org"], "t"), "http://real.org/?proxer_probe=t");
});

test("probeTokenFromUrl не путает чужой URL с маркером", () => {
  assert.equal(probeTokenFromUrl("http://example.com/?proxer_probe=abc"), "abc");
  assert.equal(probeTokenFromUrl("http://example.com/"), "");
  assert.equal(probeTokenFromUrl("not a url"), "");
  assert.equal(probeTokenFromUrl("http://example.com/?proxer_probe="), "");
});

test("failureCodeFromName переводит таймаут в сетевой код", () => {
  assert.equal(failureCodeFromName("TimeoutError"), "ERR_CONNECTION_TIMED_OUT");
  assert.equal(failureCodeFromName("TypeError"), "");
  assert.equal(failureCodeFromName(""), "");
});
