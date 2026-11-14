import test from "node:test";
import assert from "node:assert/strict";
import { profileFor, expandDomains, profileSummary } from "../lib/profiles.js";

test("profileFor находит профиль для домена и поддомена", () => {
  assert.equal(profileFor("youtube.com").site, "youtube.com");
  assert.equal(profileFor("www.youtube.com").site, "youtube.com");
  assert.equal(profileFor("m.youtube.com").site, "youtube.com");
  assert.equal(profileFor("notyoutube.com"), null);
  assert.equal(profileFor("unknown-site.example"), null);
  assert.equal(profileFor(""), null);
});

test("profileFor различает похожие домены", () => {
  assert.equal(profileFor("youtube-nocookie.com"), null);
  assert.equal(profileFor("reddit.com").site, "reddit.com");
  assert.equal(profileFor("old.reddit.com").site, "reddit.com");
});

test("expandDomains добавляет домены профиля к списку", () => {
  const domains = expandDomains(["youtube.com"], "www.youtube.com");
  assert.ok(domains.includes("youtube.com"));
  assert.ok(domains.includes("googlevideo.com"));
  assert.ok(domains.includes("ytimg.com"));
  assert.deepEqual(domains, [...domains].sort(), "список должен быть отсортирован");
  assert.equal(new Set(domains).size, domains.length, "без дублей");
});

test("expandDomains не меняет список для сайта без профиля", () => {
  assert.deepEqual(expandDomains(["example.com"], "example.com"), ["example.com"]);
});

test("expandDomains не дублирует уже добавленные домены профиля", () => {
  const domains = expandDomains(["youtube.com", "googlevideo.com"], "youtube.com");
  assert.equal(domains.filter((domain) => domain === "googlevideo.com").length, 1);
});

test("profileSummary перечисляет добавляемые домены", () => {
  const summary = profileSummary("youtube.com");
  assert.match(summary, /googlevideo\.com/);
  assert.equal(profileSummary("unknown.example"), "");
});

test("все профили валидны: нормализованные домены без протоколов", () => {
  for (const site of ["youtube.com", "netflix.com", "twitch.tv", "instagram.com", "reddit.com"]) {
    const profile = profileFor(site);
    assert.ok(profile, `нет профиля для ${site}`);
    for (const domain of profile.domains) {
      assert.match(domain, /^[a-z0-9.-]+$/, `плохой домен ${domain} в профиле ${site}`);
    }
  }
});
