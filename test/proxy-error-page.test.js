import test from "node:test";
import assert from "node:assert/strict";
import { parseErrorPageQuery } from "../lib/error-page.js";

test("parseErrorPageQuery достаёт цель и код", () => {
  const parsed = parseErrorPageQuery("?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&code=ERR_PROXY_CONNECTION_FAILED");
  assert.equal(parsed.targetUrl, "https://example.com/a?b=1");
  assert.equal(parsed.code, "ERR_PROXY_CONNECTION_FAILED");
});

test("parseErrorPageQuery отбрасывает небезопасные схемы", () => {
  assert.equal(parseErrorPageQuery("?url=javascript%3Aalert(1)").targetUrl, "");
  assert.equal(parseErrorPageQuery("?url=chrome-extension%3A%2F%2Fevil%2Fx").targetUrl, "");
  assert.equal(parseErrorPageQuery("").targetUrl, "");
  assert.equal(parseErrorPageQuery("?url=http%3A%2F%2Fexample.com").targetUrl, "http://example.com/");
});

test("parseErrorPageQuery чистит код ошибки", () => {
  assert.equal(parseErrorPageQuery("?code=%3Cscript%3E").code, "");
  assert.equal(parseErrorPageQuery("?code=ERR_TIMED_OUT").code, "ERR_TIMED_OUT");
});
