const REASONS = new Map([
  [
    "ERR_PROXY_CONNECTION_FAILED",
    {
      title: "Прокси не отвечает",
      detail: "Не удалось подключиться к прокси {endpoint}. Проверьте адрес, порт и что прокси-сервер запущен."
    }
  ],
  [
    "ERR_TUNNEL_CONNECTION_FAILED",
    { title: "Прокси отклонил подключение", detail: "Прокси {endpoint} не смог установить туннель к сайту (CONNECT)." }
  ],
  [
    "ERR_SOCKS_CONNECTION_FAILED",
    { title: "SOCKS-прокси недоступен", detail: "Не удалось подключиться к SOCKS-прокси {endpoint}." }
  ],
  [
    "ERR_SOCKS_CONNECTION_HOST_UNREACHABLE",
    { title: "Сайт недоступен через прокси", detail: "SOCKS-прокси {endpoint} не смог достучаться до сайта." }
  ],
  [
    "ERR_PROXY_AUTH_UNSUPPORTED",
    {
      title: "Прокси требует авторизации",
      detail: "Chrome не может выполнить эту авторизацию. Для SOCKS5 авторизация не поддерживается вовсе."
    }
  ],
  [
    "ERR_PROXY_AUTH_REQUESTED_WITH_NO_CONNECTION",
    { title: "Прокси требует авторизации", detail: "Проверьте логин и пароль прокси в настройках расширения." }
  ],
  [
    "ERR_CONNECTION_TIMED_OUT",
    {
      title: "Прокси не ответил",
      detail: "Истекло время ожидания ответа от прокси {endpoint}. Прокси недоступен или сайт не отвечает через него."
    }
  ],
  ["ERR_TIMED_OUT", { title: "Прокси не ответил", detail: "Истекло время ожидания ответа от прокси {endpoint}." }],
  [
    "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
    { title: "Ошибка настроек прокси", detail: "Не удалось применить PAC-скрипт расширения." }
  ]
]);

export function readErrorCode(rawError) {
  const text = String(rawError ?? "").trim();
  if (!text) return "";
  const match = /net::(ERR_[A-Z0-9_]+)/.exec(text);
  if (match) return match[1];
  return /^ERR_[A-Z0-9_]+$/.test(text) ? text : "";
}

export function describeProxyError(rawError, options = {}) {
  const code = readErrorCode(rawError);
  if (!code) return null;

  const reason = REASONS.get(code);
  if (!reason) return null;

  const endpoint = typeof options.endpoint === "string" && options.endpoint ? options.endpoint : "прокси";
  return { code, title: reason.title, detail: reason.detail.replace("{endpoint}", endpoint) };
}
