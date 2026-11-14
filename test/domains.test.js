import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, domainFromInput, findCoveringRule, toggleDomain } from "../lib/domains.js";

test("normalizeDomain приводит хост к канонической форме", () => {
  assert.equal(normalizeDomain("WWW.Example.COM."), "example.com");
  assert.equal(normalizeDomain("  sub.example.com "), "sub.example.com");
  assert.equal(normalizeDomain("www.com"), "www.com");
  assert.equal(normalizeDomain("localhost"), "localhost");
  assert.equal(normalizeDomain("1.2.3.4"), "1.2.3.4");
});

test("normalizeDomain отбрасывает мусор", () => {
  assert.equal(normalizeDomain(""), "");
  assert.equal(normalizeDomain("not a host"), "");
  assert.equal(normalizeDomain("-bad.com"), "");
  assert.equal(normalizeDomain("a..b"), "");
  assert.equal(normalizeDomain(null), "");
});

test("domainFromInput принимает URL и голый домен", () => {
  assert.equal(domainFromInput("https://www.example.com/path?q=1"), "example.com");
  assert.equal(domainFromInput("example.com/some/path"), "example.com");
  assert.equal(domainFromInput("example.com"), "example.com");
  assert.equal(domainFromInput("ftp://example.com/x"), "example.com");
  assert.equal(domainFromInput("   "), "");
});

test("findCoveringRule находит точное правило и самое специфичное родительское", () => {
  const domains = ["example.com", "sub.example.com", "other.org"];
  assert.equal(findCoveringRule(domains, "example.com"), "example.com");
  assert.equal(findCoveringRule(domains, "www.example.com"), "example.com");
  assert.equal(findCoveringRule(domains, "a.sub.example.com"), "sub.example.com");
  assert.equal(findCoveringRule(domains, "notexample.com"), null);
  assert.equal(findCoveringRule(domains, "unrelated.net"), null);
});

test("toggleDomain добавляет и снимает покрывающее правило", () => {
  assert.deepEqual(toggleDomain([], "Example.com"), ["example.com"]);
  assert.deepEqual(toggleDomain(["example.com"], "www.example.com"), []);
  assert.deepEqual(toggleDomain(["example.com", "sub.example.com"], "a.sub.example.com"), ["example.com"]);
  assert.deepEqual(toggleDomain(["example.com"], "other.org"), ["example.com", "other.org"]);
});
