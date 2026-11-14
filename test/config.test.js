import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig } from "../lib/config.js";

const validProxy = { scheme: "http", host: "1.2.3.4", port: 8080, username: "", password: "" };

test("normalizeConfig возвращает дефолт для мусора", () => {
  assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG, domains: [] });
  assert.deepEqual(normalizeConfig("nope"), { ...DEFAULT_CONFIG, domains: [] });
});

test("normalizeConfig дедуплицирует, нормализует и сортирует домены", () => {
  const config = normalizeConfig({ domains: ["WWW.B.com", "a.com", "b.com", "a.com", "", 42] });
  assert.deepEqual(config.domains, ["a.com", "b.com"]);
});

test("normalizeConfig отбрасывает невалидный прокси", () => {
  assert.equal(normalizeConfig({ proxy: { scheme: "https", host: "1.2.3.4", port: 1 } }).proxy, null);
  assert.equal(
    normalizeConfig({ proxy: { scheme: "socks5", host: "1.2.3.4", port: 1080, username: "u", password: "p" } }).proxy,
    null
  );
});

test("normalizeConfig сохраняет валидный прокси и lastError", () => {
  const config = normalizeConfig({ proxy: validProxy, domains: ["example.com"], lastError: "boom" });
  assert.deepEqual(config.proxy, validProxy);
  assert.equal(config.lastError, "boom");
  assert.equal(config.version, 1);
});
