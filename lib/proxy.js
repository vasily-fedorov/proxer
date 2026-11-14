const SCHEME_ALIASES = new Map([
  ["http", "http"],
  ["socks5", "socks5"],
  ["socks5h", "socks5"],
  ["socks", "socks5"]
]);

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$`);
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

export const PROXY_SCHEMES = Object.freeze(["http", "socks5"]);

const fail = (error) => ({ ok: false, error });

export function validateHost(host) {
  if (typeof host !== "string" || !host) return "Укажите хост прокси";
  const ipv4 = IPV4_RE.exec(host);
  if (ipv4) return ipv4.slice(1).every((part) => Number(part) <= 255) ? "" : "Некорректный IPv4-адрес";
  if (host.includes(":")) return IPV6_RE.test(host) ? "" : "Некорректный IPv6-адрес";
  return HOSTNAME_RE.test(host) ? "" : "Некорректное имя хоста";
}

export function validatePort(port) {
  const value = typeof port === "string" ? Number(port) : port;
  if (!Number.isInteger(value) || value < 1 || value > 65535) return "Порт должен быть целым числом от 1 до 65535";
  return "";
}

export function validateProxy(proxy) {
  if (!proxy || typeof proxy !== "object") return "Прокси не настроен";
  if (!PROXY_SCHEMES.includes(proxy.scheme)) return "Поддерживаются только HTTP и SOCKS5";

  const hostError = validateHost(proxy.host);
  if (hostError) return hostError;

  const portError = validatePort(proxy.port);
  if (portError) return portError;

  if (proxy.scheme === "socks5" && (proxy.username || proxy.password)) {
    return "Chrome не поддерживает авторизацию SOCKS5 — уберите логин и пароль";
  }
  return "";
}

export function formatProxyEndpoint(proxy) {
  const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
  return `${host}:${proxy.port}`;
}

export function maskProxyEndpoint(proxy) {
  if (!proxy || !proxy.host) return "";
  return `${formatProxyEndpoint(proxy)}${proxy.username ? ` (логин: ${proxy.username})` : ""}`;
}

export function parseProxyInput(text, options = {}) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return fail("Укажите адрес прокси, например 1.2.3.4:8080");

  let scheme = PROXY_SCHEMES.includes(options.scheme) ? options.scheme : "http";
  let rest = raw;
  let notice = "";

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (schemeMatch) {
    const prefix = schemeMatch[1].toLowerCase();
    if (prefix === "https") {
      return fail("HTTPS-прокси (TLS до прокси) не поддерживается — используйте http:// или socks5://");
    }
    const alias = SCHEME_ALIASES.get(prefix);
    if (!alias) return fail(`Неизвестная схема «${prefix}» — поддерживаются http и socks5`);
    scheme = alias;
    rest = rest.slice(schemeMatch[0].length);
  }

  rest = rest.split(/[/?#]/)[0];
  if (!rest) return fail("Укажите хост и порт прокси");

  let username = typeof options.username === "string" ? options.username.trim() : "";
  let password = typeof options.password === "string" ? options.password : "";

  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);

    const decoded = (value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    const colon = userinfo.indexOf(":");
    username = decoded(colon >= 0 ? userinfo.slice(0, colon) : userinfo);
    password = decoded(colon >= 0 ? userinfo.slice(colon + 1) : "");
    notice = "Логин и пароль взяты из адреса и сохранены отдельно";
  }

  let host;
  let portText;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return fail("Не закрыта квадратная скобка в IPv6-адресе");
    host = rest.slice(1, close);
    const tail = rest.slice(close + 1);
    if (!tail.startsWith(":")) return fail("Укажите порт после IPv6-адреса: [::1]:8080");
    portText = tail.slice(1);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon < 0) return fail("Укажите порт: host:port");
    host = rest.slice(0, colon);
    portText = rest.slice(colon + 1);
    if (host.includes(":")) return fail("IPv6-адрес укажите в квадратных скобках: [::1]:8080");
  }

  host = host.trim().toLowerCase();
  const hostError = validateHost(host);
  if (hostError) return fail(hostError);

  portText = portText.trim();
  const portError = validatePort(portText);
  if (portError) return fail(portError);

  const proxy = { scheme, host, port: Number(portText), username, password };
  const proxyError = validateProxy(proxy);
  if (proxyError) return fail(proxyError);

  return { ok: true, proxy, notice };
}
