# Proxer — расширение Chrome для проксирования выбранных сайтов

Дата: 2026-11-14
Статус: утверждено к реализации

## 1. Цель

Расширение Chrome (Manifest V3) маршрутизирует заданный список доменов через
пользовательский прокси (HTTP или SOCKS5) и позволяет включать/выключать
прокси для текущего сайта одним кликом по иконке или горячей клавишей.

Границы: только Chrome и Edge (Chromium). Firefox, Safari и per-tab прокси не
поддерживаются — см. раздел 12.

## 2. Сценарии

**S1. Включить прокси для сайта.** Пользователь на сайте → клик по иконке (или
`Ctrl+Shift+Y`) → домен добавляется в постоянный список → вкладка
перезагружается → на иконке зелёный badge `ON`. Состояние переживает перезапуск
браузера.

**S2. Выключить прокси для сайта.** Повторный клик на покрытом домене удаляет
покрывающее правило → вкладка перезагружается → badge пуст.

**S3. Управление списком.** Страница настроек: адрес прокси, логин/пароль,
список доменов с удалением, ручное добавление.

**S4. Прокси недоступен.** Fail-closed: сайт не открывается напрямую. Вместо
страницы ошибки Chrome вкладка показывает страницу расширения с причиной,
адресом прокси (пароль замаскирован), кнопкой «Повторить» и ссылкой в настройки.

**S5. Прокси требует авторизации.** При HTTP 407 на запрос к домену из списка
расширение отдаёт сохранённые логин/пароль.

## 3. Ключевые технические решения

| Решение | Обоснование |
|---|---|
| `chrome.proxy.settings` в режиме `pac_script` с inline `pacScript.data` | Единственный способ пер-доменной маршрутизации; `fixed_servers` + `bypassList` не умеет «проксировать только список». Inline data исключает отдельный запрос PAC-файла и класс ошибок с его загрузкой. |
| `pacScript.mandatory: true` | При ошибке в PAC Chrome иначе молча уходит в DIRECT. `mandatory` превращает это в отказ сети. |
| Возврат к системным настройкам через `settings.clear({scope:"regular"})` | Снимает наш слой и отдаёт управление политике/командной строке/ОС/другому расширению. `mode:"system"` пишет явное значение в наш слой и перекрывает их. |
| Логин/пароль только через `webRequest.onAuthRequired` + `asyncBlocking`, права `webRequest` + `webRequestAuthProvider` | В PAC-строку `user:pass@host:port` Chrome вставить нельзя: парсер возвращает невалидный `ProxyServer`, запись отбрасывается, и при пустом списке трафик уходит DIRECT — тихая утечка. Только HTTP/HTTPS-прокси. |
| Fail-closed для доменов из списка | Тихого обхода прокси быть не должно: PAC возвращает только прокси, без `; DIRECT`. |
| Одно состояние одним ключом `config` в `chrome.storage.local` | Атомарность и один обработчик `storage.onChanged`. `local`, а не `sync`: пароль не должен попадать в аккаунт Google. |
| Чистые модули без `chrome.*` в `lib/` | Тестируются в Node без браузера; вся работа с API — в `background.js` и `options.js`. |

## 4. Файлы

```
manifest.json           MV3, права, команда, options_ui
background.js           service worker (type: module): клик, hotkey, PAC, auth, badge, ошибки
lib/proxy.js            parseProxyInput / formatProxyEndpoint / maskProxyEndpoint
lib/pac.js              buildPacScript(domains, proxy)
lib/domains.js          normalizeDomain / findCoveringRule / toggleDomain
lib/errors.js           PROXY_ERROR_REASONS + describeProxyError(error)
options.html/.css/.js   страница настроек
proxy-error.html/.js    страница сбоя прокси
test/*.test.js          node:test юнит-тесты
dev/e2e.mjs             e2e-харнесс (Chrome + локальный прокси + CDP)
package.json            type: module, скрипты test / test:e2e
README.md               установка, ограничения, формат ввода прокси
```

## 5. Манифест

```json
{
  "manifest_version": 3,
  "name": "Proxer",
  "version": "0.1.0",
  "minimum_chrome_version": "108",
  "permissions": ["proxy", "webRequest", "webRequestAuthProvider", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "Прокси для этого сайта" },
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "commands": {
    "toggle-site": {
      "suggested_key": { "default": "Ctrl+Shift+Y", "mac": "Command+Shift+Y" },
      "description": "Включить/выключить прокси для текущего сайта"
    }
  }
}
```

`webRequestBlocking` не запрашивается (в MV3 доступен только policy-installed).
Иконки в v1 не поставляются (Chrome показывает дефолтную); индикация — badge.

## 6. Модель данных

`chrome.storage.local`, единственный ключ `config`:

```js
{
  version: 1,
  proxy: {                 // null — прокси не настроен
    scheme: "http" | "socks5",
    host: "1.2.3.4",
    port: 8080,
    username: "",          // пустая строка — без авторизации
    password: ""
  },
  domains: ["example.com"], // нормализованные, без префикса www, уникальные
  lastError: null           // текст последней ошибки применения конфига
}
```

Правила:
- `domains` пуст или `proxy === null` → `settings.clear({scope:"regular"})`.
- `scheme === "socks5"` с непустыми `username`/`password` → сохранение отклоняется
  с сообщением, что Chrome не поддерживает авторизацию SOCKS5.

## 7. Разбор прокси

`parseProxyInput(text, {scheme, username, password})` возвращает
`{ok: true, proxy}` либо `{ok: false, error}`.

Принимаемый ввод в поле адреса: `host:port`, `http://host:port`,
`socks5://host:port`, `[2001:db8::1]:8080`. Схема берётся из префикса, если он
есть, иначе из селектора. Если во вводе есть `user:pass@`, они переносятся в
поля логина/пароля с пометкой «логин и пароль взяты из адреса» — в хранилище и в
PAC они попадут только раздельно.

Валидация: host — `[a-z0-9.-]` либо bracketed IPv6; port — целое 1..65535;
схема — только `http` и `socks5` (`https`-прокси в v1 не поддерживается,
сообщение об этом).

`formatProxyEndpoint(proxy)` → `"1.2.3.4:8080"`; `maskProxyEndpoint(proxy)`
никогда не содержит пароль и используется во всём UI и на странице ошибки.

## 8. PAC

```js
function buildPacScript(domains, proxy) {
  const target = proxy.scheme === "socks5" ? "SOCKS5" : "PROXY";
  const endpoint = formatProxyEndpoint(proxy); // host:port, без credentials
  return [
    "function FindProxyForURL(url, host) {",
    `  var list = ${JSON.stringify(domains)};`,
    "  for (var i = 0; i < list.length; i++) {",
    '    if (host === list[i] || dnsDomainIs(host, "." + list[i])) {',
    `      return "${target} ${endpoint}";`,
    "    }",
    "  }",
    '  return "DIRECT";',
    "}"
  ].join("\n");
}
```

Инварианты: ни одного `@` в тексте PAC; `host` и `port` только из
валидированных полей; правило `example.com` покрывает `example.com` и
`*.example.com` (за счёт ведущей точки в `dnsDomainIs`); для доменов из списка
возвращается ровно один прокси без `DIRECT`-фолбэка.

`applyConfig()`: собрать PAC → `settings.set({value:{mode:"pac_script",
pacScript:{data, mandatory:true}}, scope:"regular"})`. При ошибке `set` — вернуть
предыдущее валидное состояние, записать текст ошибки в `config.lastError` и
показать его в настройках; браузер не остаётся без прокси молча.

## 9. Точки входа и поведение

**`action.onClicked`** и **`commands.onCommand`** → одна функция `handleToggle(tab)`:
1. `tab.url` не `http(s)` → ничего не делать.
2. `normalizeDomain(new URL(url).hostname)`: lowercase, снять завершающую точку,
   снять один ведущий `www.`, punycode уже обеспечен `URL`.
3. `findCoveringRule(domains, host)` → есть правило: удалить именно его (точное
   совпадение приоритетнее родительского); нет: добавить `host`.
4. Сохранить `config`, `applyConfig()`, `chrome.tabs.reload(tab.id)`.

**Badge.** `ON` (зелёный) — хост покрыт правилом; `""` — нет. `setTitle`
показывает правило: `Прокси: example.com (правило example.com)` либо
`Сайт идёт напрямую`. Обновляется на `tabs.onActivated`, `tabs.onUpdated`
(`status === "complete"`), при старте и после изменения конфига.

**Состояние в service worker.** Service worker выгружается браузером, поэтому
in-memory копия `state.config` не является источником истины: `loadConfig()`
читает `chrome.storage.local` и кэширует промис; кэш сбрасывается на
`storage.onChanged`. Все обработчики, которым нужен конфиг (клик, хоткей, auth,
badge, ошибки), вызывают `await loadConfig()`, а не читают `state` напрямую.
Слушатели регистрируются синхронно на верхнем уровне модуля — иначе после
пробуждения worker событие не будет поймано.

**Auth.** В top-level service worker:

```js
chrome.webRequest.onAuthRequired.addListener(
  async (details, callback) => {
    const config = await loadConfig();
    const host = safeHost(details.url);
    const proxy = config.proxy;
    if (details.isProxy && proxy?.username && proxy.scheme === "http" &&
        host && findCoveringRule(config.domains, host)) {
      callback({ authCredentials: { username: proxy.username, password: proxy.password } });
      return;
    }
    callback({});   // не наш прокси — пусть Chrome решает сам
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
```

`details.isProxy` обязателен в проверке: иначе перехватываются логины самих
сайтов (401).

## 10. Недоступный прокси

**Детект.** `webRequest.onErrorOccurred`, только `details.type === "main_frame"`,
`details.tabId >= 0`, хост покрыт правилом, наш конфиг активен, и код ошибки из
списка:

| Код | Текст для пользователя |
|---|---|
| `net::ERR_PROXY_CONNECTION_FAILED` | Прокси не отвечает: `<endpoint>`. Проверьте адрес, порт и что прокси-сервер запущен. |
| `net::ERR_TUNNEL_CONNECTION_FAILED` | Прокси отклонил подключение к сайту (CONNECT). |
| `net::ERR_SOCKS_CONNECTION_FAILED` | SOCKS-прокси недоступен: `<endpoint>`. |
| `net::ERR_PROXY_AUTH_UNSUPPORTED` | Прокси требует авторизации, которую Chrome не может выполнить. Для SOCKS5 авторизация не поддерживается. |
| `net::ERR_CONNECTION_TIMED_OUT` | Таймаут: прокси не ответил или сайт недоступен через прокси. |
| `net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED` | Не удалось применить настройки прокси (ошибка PAC). |

Остальные ошибки (`ERR_NAME_NOT_RESOLVED`, `ERR_CONNECTION_REFUSED` и т. п.) не
перехватываются: их причина — сайт, а не прокси.

**Действие.** `chrome.tabs.update(tabId, {url: proxy-error.html?url=<original>&code=<error>})`.
Повторной переадресации нет: перед заменой проверяется, что текущий URL вкладки
ещё не наша страница ошибки. На иконке вкладки — красный badge `!`, снимается
при успешном `onCompleted` main_frame для покрытого хоста.

**Страница `proxy-error.html`.** Показывает: «Не удалось открыть `<host>` через
прокси», текст причины по коду, `<endpoint>` без пароля, кнопки «Повторить»
(`tabs.update` на исходный URL) и «Настройки» (`runtime.openOptionsPage`).
Параметры валидируются (только `http`/`https`), всё выводится через
`textContent` — HTML из URL не интерполируется. Кнопки «открыть напрямую» нет:
это обошло бы fail-closed; чтобы открыть сайт напрямую, пользователь удаляет
домен из списка.

**Ошибки PAC.** `proxy.onProxyError` с `details.fatal` → красный badge и баннер в
настройках с текстом `details.error`.

## 11. Страница настроек

Секции:
1. **Прокси** — селектор схемы (HTTP / SOCKS5), адрес `host:port`, логин,
   пароль, «Сохранить». Для SOCKS5 поля логина/пароля disabled с подсказкой об
   ограничении Chrome. Статус сохранения или текст ошибки валидации.
2. **Добавить сайт** — поле (принимает URL или домен), «Добавить».
3. **Список сайтов** — строки с доменом и «Удалить», empty-state с подсказкой про
   клик по иконке.
4. **Состояние** — текущий endpoint (пароль замаскирован), количество доменов,
   баннер `levelOfControl !== "controlled_by_this_extension"` («прокси
   управляется политикой или другим расширением, настройки не применятся»),
   `lastError`, если есть.

## 12. Ограничения

- Пароль хранится в `chrome.storage.local` в открытом виде — Chrome не даёт иного
  способа; доступен только расширению и тому, у кого есть доступ к профилю.
- Авторизация SOCKS5 невозможна в Chrome; `onAuthRequired` для SOCKS не
  вызывается.
- После сбоя прокси в адресной строке будет `chrome-extension://…/proxy-error.html`,
  а не адрес сайта: Chrome не позволяет рисовать на своей странице ошибки.
- Прокси-конфигурация действует на весь профиль, не на отдельную вкладку.
- Если прокси-настройками управляет политика или другое расширение,
  `settings.set` не возымеет эффекта — UI обязан это показать, а не молчать.
- SOCKS5: DNS резолвится на стороне прокси (Chrome не имеет режима локального
  резолва); для HTTP-прокси имя хоста передаётся в CONNECT.

## 13. Вне скоупа v1

Firefox/Safari, per-tab прокси, несколько прокси и переключение между ними,
правила «этот поддомен — напрямую», импорт/экспорт списка, `storage.sync`,
иконки и прочая косметика, автообновление, i18n.

## 14. Тестирование

**Юнит (`npm test`, `node --test`):**
- `parseProxyInput`: все принимаемые формы; отказ на пустой порт, порт 0/65536,
  `https://`-прокси, мусорный host; перенос `user:pass@` в отдельные поля.
- `buildPacScript`: покрытие домена и поддоменов, `DIRECT` для остальных,
  отсутствие `@` при заданных credentials, `SOCKS5`/`PROXY` по схеме,
  `JSON.stringify` экранирует домен.
- `normalizeDomain`: `www.`, завершающая точка, регистр, punycode.
- `findCoveringRule` / `toggleDomain`: точное совпадение приоритетнее
  родительского правила; повторный toggle возвращает исходное состояние.
- `describeProxyError` + `maskProxyEndpoint`: каждый код из таблицы, пароль не
  попадает в текст.

**E2E (`npm run test:e2e`, `dev/e2e.mjs`):** поднимает локальный CONNECT-прокси
(логирует каждый CONNECT и GET с хостом) и апстрим-HTTP-сервер, отдающий маркер
`proxied-ok`. Chrome запускается с `--load-extension`, временным профилем,
`--host-resolver-rules="MAP target.test 127.0.0.1, MAP control.test 127.0.0.1"`
и CDP; id расширения берётся из списка целей, конфиг задаётся через
`chrome.storage.local.set` в контексте страницы настроек. Сценарии:
- A: прокси работает → запрос к домену из списка виден в логе прокси, страница
  отрендерилась; контрольный домен вне списка в лог не попал.
- B: прокси указывает на закрытый порт → вкладка оказалась на
  `proxy-error.html`, в тексте есть endpoint и пароль отсутствует.
Если headless-режим Chrome не поддерживает расширения в текущей сборке, харнесс
запускается под `xvfb-run`; способ запуска фиксируется в README.

## 15. Критерии готовности

1. Клик и хоткей включают/выключают прокси для текущего домена и перезагружают
   вкладку; badge отражает состояние.
2. После перезапуска браузера список и прокси применяются автоматически.
3. Пустой список или отсутствие прокси возвращают системные настройки через
   `clear`.
4. Прокси с логином/паролем (HTTP) работает; пароль не встречается в PAC.
5. При недоступном прокси вкладка показывает нашу страницу с причиной; трафик
   не уходит напрямую.
6. `npm test` и `npm run test:e2e` проходят.
