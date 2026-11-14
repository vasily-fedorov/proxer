import test from "node:test";
import assert from "node:assert/strict";
import { buildPacScript } from "../lib/pac.js";

const httpProxy = { scheme: "http", host: "10.0.0.1", port: 8080, username: "", password: "" };

function pacResolver(script) {
  const dnsDomainIs = (host, domain) => host.length >= domain.length && host.slice(-domain.length) === domain;
  const factory = new Function("dnsDomainIs", `${script}\nreturn FindProxyForURL;`);
  return factory(dnsDomainIs);
}

test("PAC направляет домен и его поддомены в прокси, остальное напрямую", () => {
  const find = pacResolver(buildPacScript(["example.com"], httpProxy));
  assert.equal(find("https://example.com/", "example.com"), "PROXY 10.0.0.1:8080");
  assert.equal(find("https://a.example.com/", "a.example.com"), "PROXY 10.0.0.1:8080");
  assert.equal(find("https://notexample.com/", "notexample.com"), "DIRECT");
  assert.equal(find("https://example.com.evil.net/", "example.com.evil.net"), "DIRECT");
});

test("PAC для домена из списка не содержит DIRECT-фолбэка (fail-closed)", () => {
  const find = pacResolver(buildPacScript(["example.com"], httpProxy));
  assert.equal(find("https://example.com/", "example.com").includes("DIRECT"), false);
});

test("PAC выбирает SOCKS5 и форматирует IPv6", () => {
  const find = pacResolver(
    buildPacScript(["example.com"], { scheme: "socks5", host: "2001:db8::1", port: 1080, username: "", password: "" })
  );
  assert.equal(find("https://example.com/", "example.com"), "SOCKS5 [2001:db8::1]:1080");
});

test("PAC не содержит учётных данных даже при заданном пароле", () => {
  const script = buildPacScript(["example.com"], {
    scheme: "http",
    host: "10.0.0.1",
    port: 8080,
    username: "user",
    password: "s3cret"
  });
  assert.equal(script.includes("@"), false);
  assert.equal(script.includes("s3cret"), false);
});

test("PAC экранирует домены и пустой список даёт только DIRECT", () => {
  const find = pacResolver(buildPacScript([], httpProxy));
  assert.equal(find("https://example.com/", "example.com"), "DIRECT");
  const script = buildPacScript(['weird"domain.com'], httpProxy);
  assert.doesNotThrow(() => pacResolver(script));
});
