import test from "node:test";
import assert from "node:assert/strict";
import {
  registrableDomain,
  isIgnorableCode,
  suggestionFor,
  addSuggestion,
  pruneSuggestions,
  suggestionCountFor
} from "../lib/suggestions.js";

test("registrableDomain сворачивает CDN-хосты до домена", () => {
  assert.equal(registrableDomain("rr4---sn-4g5e6nzs.googlevideo.com"), "googlevideo.com");
  assert.equal(registrableDomain("i.ytimg.com"), "ytimg.com");
  assert.equal(registrableDomain("youtube.com"), "youtube.com");
  assert.equal(registrableDomain("a.b.c.d.example.org"), "example.org");
});

test("registrableDomain учитывает двухуровневые зоны", () => {
  assert.equal(registrableDomain("cdn.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("a.b.example.com.br"), "example.com.br");
  assert.equal(registrableDomain("example.co.uk"), "example.co.uk");
});

test("registrableDomain не ломает IP-адреса и localhost", () => {
  assert.equal(registrableDomain("127.0.0.1"), "127.0.0.1");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(registrableDomain(""), "");
});

test("isIgnorableCode отсеивает нормальные прерывания", () => {
  assert.equal(isIgnorableCode("ERR_ABORTED"), true);
  assert.equal(isIgnorableCode("net::ERR_BLOCKED_BY_CLIENT"), true);
  assert.equal(isIgnorableCode("ERR_BLOCKED_BY_RESPONSE"), true);
  assert.equal(isIgnorableCode("ERR_CACHE_MISS"), true);
  assert.equal(isIgnorableCode("ERR_CONNECTION_RESET"), false);
  assert.equal(isIgnorableCode("ERR_NAME_NOT_RESOLVED"), false);
  assert.equal(isIgnorableCode(""), true);
});

test("suggestionFor предлагает чужой домен, который не идёт через прокси", () => {
  const domain = suggestionFor({
    error: "net::ERR_CONNECTION_RESET",
    url: "https://rr4---sn-4g5e6nzs.googlevideo.com/videoplayback",
    pageHost: "youtube.com",
    domains: ["youtube.com", "googlevideo.com"]
  });
  assert.equal(domain, null, "домен уже покрыт правилом");

  const fresh = suggestionFor({
    error: "net::ERR_CONNECTION_RESET",
    url: "https://rr4---sn-4g5e6nzs.googlevideo.com/videoplayback",
    pageHost: "youtube.com",
    domains: ["youtube.com"]
  });
  assert.equal(fresh, "googlevideo.com");
});

test("suggestionFor молчит для непокрытой страницы и своего же домена", () => {
  assert.equal(
    suggestionFor({
      error: "net::ERR_CONNECTION_RESET",
      url: "https://cdn.other.com/x",
      pageHost: "example.org",
      domains: ["youtube.com"]
    }),
    null
  );
  assert.equal(
    suggestionFor({
      error: "net::ERR_CONNECTION_RESET",
      url: "https://www.youtube.com/watch",
      pageHost: "youtube.com",
      domains: ["youtube.com"]
    }),
    null
  );
});

test("suggestionFor игнорирует шумные коды ошибок", () => {
  assert.equal(
    suggestionFor({
      error: "net::ERR_ABORTED",
      url: "https://cdn.other.com/x",
      pageHost: "youtube.com",
      domains: ["youtube.com"]
    }),
    null
  );
});

test("addSuggestion накапливает без дублей и сортирует", () => {
  const first = addSuggestion([], { site: "youtube.com", domain: "googlevideo.com" });
  assert.deepEqual(first, [{ site: "youtube.com", domain: "googlevideo.com" }]);

  const second = addSuggestion(first, { site: "youtube.com", domain: "ytimg.com" });
  assert.equal(second.length, 2);

  const dupe = addSuggestion(second, { site: "youtube.com", domain: "ytimg.com" });
  assert.equal(dupe, second, "повтор не должен менять список");
});

test("addSuggestion ограничивает список на сайт", () => {
  let list = [];
  for (let i = 0; i < 40; i += 1) {
    list = addSuggestion(list, { site: "youtube.com", domain: `cdn${i}.example` });
  }
  assert.ok(list.length <= 20, `слишком длинный список: ${list.length}`);
});

test("addSuggestion отбрасывает мусор", () => {
  assert.deepEqual(addSuggestion([], { site: "", domain: "x.com" }), []);
  assert.deepEqual(addSuggestion([], { site: "youtube.com", domain: "" }), []);
});

test("pruneSuggestions убирает домены, ставшие покрытыми", () => {
  const list = [
    { site: "youtube.com", domain: "googlevideo.com" },
    { site: "youtube.com", domain: "ytimg.com" }
  ];
  assert.deepEqual(pruneSuggestions(list, ["youtube.com", "googlevideo.com"]), [
    { site: "youtube.com", domain: "ytimg.com" }
  ]);
  assert.deepEqual(pruneSuggestions(list, []), list);
});

test("suggestionCountFor считает подсказки сайта", () => {
  const list = [
    { site: "youtube.com", domain: "a.com" },
    { site: "youtube.com", domain: "b.com" },
    { site: "reddit.com", domain: "c.com" }
  ];
  assert.equal(suggestionCountFor(list, "youtube.com"), 2);
  assert.equal(suggestionCountFor(list, "www.youtube.com"), 2);
  assert.equal(suggestionCountFor(list, "reddit.com"), 1);
  assert.equal(suggestionCountFor(list, "other.org"), 0);
});
