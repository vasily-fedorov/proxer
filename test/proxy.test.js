import test from "node:test";
import assert from "node:assert/strict";
import { parseProxyInput, formatProxyEndpoint, maskProxyEndpoint, validateProxy } from "../lib/proxy.js";

test("parseProxyInput принимает host:port и префиксы схем", () => {
  const plain = parseProxyInput("1.2.3.4:8080");
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.proxy, { scheme: "http", host: "1.2.3.4", port: 8080, username: "", password: "" });

  assert.equal(parseProxyInput("socks5://proxy.local:1080").proxy.scheme, "socks5");
  assert.equal(parseProxyInput("socks5h://proxy.local:1080").proxy.scheme, "socks5");
  assert.equal(parseProxyInput("http://proxy.local:3128/").proxy.host, "proxy.local");
});

test("parseProxyInput берёт схему из селектора, если префикса нет", () => {
  assert.equal(parseProxyInput("proxy.local:1080", { scheme: "socks5" }).proxy.scheme, "socks5");
});

test("parseProxyInput выносит логин и пароль из адреса в отдельные поля", () => {
  const result = parseProxyInput("http://user:p%40ss@proxy.local:8080");
  assert.equal(result.ok, true);
  assert.equal(result.proxy.username, "user");
  assert.equal(result.proxy.password, "p@ss");
  assert.match(result.notice, /взяты из адреса/);
});

test("parseProxyInput отвергает некорректный ввод", () => {
  assert.equal(parseProxyInput("").ok, false);
  assert.match(parseProxyInput("proxy.local").error, /порт/i);
  assert.match(parseProxyInput("proxy.local:0").error, /порт/i);
  assert.match(parseProxyInput("proxy.local:65536").error, /порт/i);
  assert.match(parseProxyInput("https://proxy.local:8080").error, /HTTPS/i);
  assert.match(parseProxyInput("ftp://proxy.local:8080").error, /схема/i);
  assert.match(parseProxyInput("::1:8080").error, /скобк/i);
});

test("parseProxyInput принимает IPv6 в скобках", () => {
  const result = parseProxyInput("[2001:db8::1]:8080");
  assert.equal(result.ok, true);
  assert.equal(result.proxy.host, "2001:db8::1");
  assert.equal(formatProxyEndpoint(result.proxy), "[2001:db8::1]:8080");
});

test("validateProxy отвергает авторизацию SOCKS5", () => {
  const error = validateProxy({ scheme: "socks5", host: "1.2.3.4", port: 1080, username: "u", password: "p" });
  assert.match(error, /SOCKS5/);
  assert.equal(parseProxyInput("socks5://u:p@1.2.3.4:1080").ok, false);
});

test("maskProxyEndpoint никогда не содержит пароль", () => {
  const proxy = { scheme: "http", host: "1.2.3.4", port: 8080, username: "user", password: "s3cret" };
  assert.equal(maskProxyEndpoint(proxy), "1.2.3.4:8080 (логин: user)");
  assert.ok(!maskProxyEndpoint(proxy).includes("s3cret"));
  assert.equal(
    maskProxyEndpoint({ scheme: "http", host: "1.2.3.4", port: 8080, username: "", password: "" }),
    "1.2.3.4:8080"
  );
});
