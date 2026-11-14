import test from "node:test";
import assert from "node:assert/strict";
import { describeProxyError, readErrorCode } from "../lib/errors.js";

test("readErrorCode понимает формат chrome.webRequest", () => {
  assert.equal(readErrorCode("net::ERR_PROXY_CONNECTION_FAILED"), "ERR_PROXY_CONNECTION_FAILED");
  assert.equal(readErrorCode("ERR_TIMED_OUT"), "ERR_TIMED_OUT");
  assert.equal(readErrorCode(""), "");
  assert.equal(readErrorCode("some other text"), "");
});

test("describeProxyError объясняет недоступный прокси и подставляет endpoint", () => {
  const reason = describeProxyError("net::ERR_PROXY_CONNECTION_FAILED", { endpoint: "1.2.3.4:8080" });
  assert.equal(reason.code, "ERR_PROXY_CONNECTION_FAILED");
  assert.match(reason.title, /не отвечает/i);
  assert.match(reason.detail, /1\.2\.3\.4:8080/);
});

test("describeProxyError покрывает все коды из спецификации", () => {
  const codes = [
    "net::ERR_PROXY_CONNECTION_FAILED",
    "net::ERR_TUNNEL_CONNECTION_FAILED",
    "net::ERR_SOCKS_CONNECTION_FAILED",
    "net::ERR_PROXY_AUTH_UNSUPPORTED",
    "net::ERR_CONNECTION_TIMED_OUT",
    "net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED"
  ];
  for (const code of codes) {
    const reason = describeProxyError(code, { endpoint: "proxy:8080" });
    assert.ok(reason, `нет описания для ${code}`);
    assert.ok(reason.title.length > 0);
    assert.ok(reason.detail.length > 0);
  }
});

test("describeProxyError не перехватывает ошибки сайта", () => {
  assert.equal(describeProxyError("net::ERR_NAME_NOT_RESOLVED"), null);
  assert.equal(describeProxyError("net::ERR_CONNECTION_REFUSED"), null);
  assert.equal(describeProxyError(""), null);
});
