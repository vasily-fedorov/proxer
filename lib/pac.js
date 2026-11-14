import { formatProxyEndpoint } from "./proxy.js";

export function buildPacScript(domains, proxy) {
  const list = Array.isArray(domains) ? domains.filter((domain) => typeof domain === "string" && domain) : [];
  const kind = proxy?.scheme === "socks5" ? "SOCKS5" : "PROXY";
  const target = `${kind} ${formatProxyEndpoint(proxy)}`;
  if (target.includes("@")) throw new Error("PAC-строка не может содержать логин или пароль");

  return [
    "function FindProxyForURL(url, host) {",
    `  var list = ${JSON.stringify(list)};`,
    "  for (var i = 0; i < list.length; i++) {",
    '    if (host === list[i] || dnsDomainIs(host, "." + list[i])) {',
    `      return ${JSON.stringify(target)};`,
    "    }",
    "  }",
    '  return "DIRECT";',
    "}"
  ].join("\n");
}
