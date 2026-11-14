/**
 * Предустановленные профили: домены, которые нужны популярным сайтам для
 * подресурсов (медиа, картинки, CDN). Список осознанно короткий и best-effort:
 * он устаревает, поэтому основную работу делает автообнаружение в suggestions.js.
 */
const PROFILES = Object.freeze([
  {
    site: "youtube.com",
    domains: ["googlevideo.com", "ytimg.com", "ggpht.com", "youtube-nocookie.com", "youtu.be", "googleusercontent.com"]
  },
  { site: "netflix.com", domains: ["nflxvideo.net", "nflximg.net", "nflxso.net", "nflxext.com"] },
  { site: "twitch.tv", domains: ["ttvnw.net", "jtvnw.net", "twitchcdn.net", "ext-twitch.tv"] },
  { site: "instagram.com", domains: ["cdninstagram.com", "fbcdn.net"] },
  { site: "reddit.com", domains: ["redd.it", "redditmedia.com", "redditstatic.com"] },
  { site: "x.com", domains: ["twimg.com"] },
  { site: "twitter.com", domains: ["twimg.com"] }
]);

const covers = (site, host) => host === site || host.endsWith(`.${site}`);

export function profileFor(host) {
  if (typeof host !== "string") return null;
  const target = host.trim().toLowerCase();
  if (!target) return null;
  return PROFILES.find((profile) => covers(profile.site, target)) || null;
}

export function expandDomains(domains, host) {
  const list = Array.isArray(domains) ? [...domains] : [];
  const profile = profileFor(host);
  if (!profile) return list;

  const seen = new Set(list);
  for (const domain of profile.domains) {
    if (seen.has(domain)) continue;
    seen.add(domain);
    list.push(domain);
  }
  return list.sort();
}

export function profileSummary(host) {
  const profile = profileFor(host);
  return profile ? profile.domains.join(", ") : "";
}
