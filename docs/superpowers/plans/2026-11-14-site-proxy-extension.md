# Proxer — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development или superpowers:executing-plans. Шаги отмечены `- [ ]`.

**Goal:** расширение Chrome MV3, которое проводит выбранные домены через пользовательский HTTP/SOCKS5-прокси, переключается кликом или хоткеем и показывает свою страницу с причиной, когда прокси недоступен.

**Architecture:** `chrome.proxy.settings` в режиме `pac_script` с inline-PAC и `mandatory: true`; PAC отдаёт прокси только для доменов списка (fail-closed). Логин/пароль идут исключительно через `webRequest.onAuthRequired` + `asyncBlocking` и никогда не попадают в PAC. Чистая логика — в `lib/*` без `chrome.*`, поэтому тестируется в Node; работа с API — в `store.js`, `background.js` и страницах.

**Tech Stack:** Chrome/Edge 108+, Manifest V3, ES-модули, `node:test`, raw CDP для e2e. Ноль runtime-зависимостей.

**Spec:** `docs/superpowers/specs/2026-11-14-site-proxy-extension-design.md`

## Global Constraints

- Только Chrome/Edge (Chromium); `manifest_version: 3`, `minimum_chrome_version: "108"`.
- Права: `proxy`, `webRequest`, `webRequestAuthProvider`, `storage`; `host_permissions: ["<all_urls>"]`. `webRequestBlocking` не запрашивать.
- Хранилище — только `chrome.storage.local`, единственный ключ `config`; `storage.sync` не использовать.
- В тексте PAC не должно быть `@` и пароля ни при каком вводе.
- Для доменов списка PAC возвращает только прокси, без `; DIRECT`.
- Возврат системных настроек — `chrome.proxy.settings.clear({scope:"regular"})`.
- Схемы: только `http` и `socks5`; авторизация SOCKS5 отклоняется при сохранении.
- Весь UI — на русском. Внешних зависимостей нет.
- Service worker — `"type": "module"`, слушатели регистрируются синхронно на верхнем уровне.
- `npm test` = `node --test test/`, один прогон, без фиксированных задержек для синхронизации.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `lib/domains.js` | нормализация хоста, разбор пользовательского ввода, покрытие поддоменов, toggle |
| `lib/proxy.js` | разбор строки прокси, валидация, форматирование и маскирование endpoint |
| `lib/pac.js` | генерация PAC-скрипта |
| `lib/errors.js` | коды сетевых ошибок → человеческий текст |
| `lib/config.js` | нормализация и дефолты конфига |
| `lib/options-model.js` | чистая логика формы настроек |
| `lib/error-page.js` | разбор и валидация query страницы сбоя |
| `store.js` | чтение/запись `storage.local`, применение PAC, откат |
| `background.js` | клик, хоткей, badge, auth, перехват сбоя, bootstrap |
| `options.html/.css/.js` | страница настроек |
| `proxy-error.html/.js` | страница сбоя |
| `dev/cdp.mjs`, `dev/e2e.mjs` | e2e в реальном Chrome |
| `test/*.test.js` | юнит-тесты |

---

### Task 1: Скаффолд и модуль доменов

**Files:** create `package.json`, `.gitignore`, `lib/domains.js`, `test/domains.test.js`

**Interfaces:** производит `normalizeDomain(input)->string`, `domainFromInput(input)->string`, `findCoveringRule(domains, host)->string|null`, `toggleDomain(domains, host)->string[]`.

- [ ] `package.json`: `{"name":"proxer","version":"0.1.0","private":true,"type":"module","scripts":{"test":"node --test test/","test:e2e":"node dev/e2e.mjs"}}`. `.gitignore`: `node_modules/`, `.omo/`, `tmp/`.
- [ ] Тест `test/domains.test.js` покрывает: `normalizeDomain("WWW.Example.COM.") === "example.com"`, `"www.com"` остаётся `"www.com"`, `"localhost"` и `"1.2.3.4"` проходят, `""`/`"not a host"`/`"-bad.com"`/`"a..b"`/`null` → `""`; `domainFromInput` принимает `https://www.example.com/path?q=1` → `example.com`, `example.com/some/path`, `ftp://example.com/x`; `findCoveringRule` для `["example.com","sub.example.com","other.org"]` даёт точное совпадение, `www.example.com → example.com`, `a.sub.example.com → sub.example.com`, `notexample.com → null`; `toggleDomain([], "Example.com") → ["example.com"]`, повторный toggle на поддомене снимает правило, добавление чужого домена сохраняет сортировку.
- [ ] `npm test` → FAIL (`Cannot find module`).
- [ ] Реализация: `HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/`; `normalizeDomain` — trim+lowercase, снять завершающую точку, вернуть `localhost` как есть, снять один ведущий `www.` только если остаток содержит точку, иначе `""`, если не прошло regex. `domainFromInput` — при наличии схемы `new URL(...).hostname`, иначе отрезать `[/?#]` и нормализовать. `findCoveringRule` — точное совпадение сразу побеждает, иначе самое длинное правило, где `target.endsWith("." + rule)`. `toggleDomain` — снять покрывающее правило либо добавить отсортированным без дублей.
- [ ] `npm test` → PASS.
- [ ] Commit: `feat: модуль нормализации доменов и список правил`.

---

### Task 2: Разбор и валидация прокси

**Files:** create `lib/proxy.js`, `test/proxy.test.js`

**Interfaces:** производит `PROXY_SCHEMES` (`["http","socks5"]`), `parseProxyInput(text, {scheme, username, password}) -> {ok:true, proxy, notice?} | {ok:false, error}`, `validateHost`, `validatePort`, `validateProxy(proxy)->string` (пустая строка = валиден), `formatProxyEndpoint(proxy)->string`, `maskProxyEndpoint(proxy)->string`. `proxy = {scheme, host, port:number, username, password}`.

- [ ] Тест покрывает: `"1.2.3.4:8080"` → `{scheme:"http",host:"1.2.3.4",port:8080,username:"",password:""}`; префиксы `socks5://`, `socks5h://` → `socks5`, `http://proxy.local:3128/` → host без слеша; схема из селектора при отсутствии префикса; `user:p%40ss@host:port` переносит креды в поля (пароль `p@ss`) и возвращает `notice` про «взяты из адреса»; ошибки для `""`, без порта, порт `0`/`65536`, `https://` («HTTPS»), `ftp://` («схема»), `::1:8080` («скобк»); IPv6 `[2001:db8::1]:8080` и формат `[2001:db8::1]:8080`; `validateProxy` для socks5 с кредами возвращает текст про SOCKS5, `parseProxyInput("socks5://u:p@1.2.3.4:1080").ok === false`; `maskProxyEndpoint({username:"user",password:"s3cret"})` → `"1.2.3.4:8080 (логин: user)"` и не содержит `s3cret`.
- [ ] `npm test` → FAIL.
- [ ] Реализация: алиасы схем `http/socks5/socks5h/socks` (последние два → `socks5`); `https` — явная ошибка про отсутствие TLS-до-прокси; `rest.split(/[/?#]/)[0]`; userinfo отделяется по последнему `@`, декодируется `decodeURIComponent` с fallback на исходную строку; IPv6 только в скобках, иначе ошибка про скобки; `validateHost` проверяет IPv4 по октетам ≤255, IPv6 по `[0-9a-f:]+`, иначе hostname-regex с обязательной точкой (плюс `localhost`); `validatePort` требует целое 1..65535. `formatProxyEndpoint` оборачивает IPv6 в скобки. `maskProxyEndpoint` добавляет только логин, пароль не читает.
- [ ] `npm test` → PASS.
- [ ] Commit: `feat: разбор и валидация строки прокси без утечки пароля в PAC`.

---

### Task 3: Генератор PAC

**Files:** create `lib/pac.js`, `test/pac.test.js`

**Interfaces:** потребляет `formatProxyEndpoint`; производит `buildPacScript(domains, proxy)->string`, бросает `Error`, если в прокси-строке оказался `@`.

- [ ] Тест исполняет PAC, а не сверяет текст: `new Function("dnsDomainIs", script + "\nreturn FindProxyForURL;")` с реализацией `dnsDomainIs = (host, domain) => host.length >= domain.length && host.slice(-domain.length) === domain`. Проверки: `example.com` и `a.example.com` → `"PROXY 10.0.0.1:8080"`; `notexample.com` и `example.com.evil.net` → `"DIRECT"`; для домена из списка результат не содержит `DIRECT`; socks5 + IPv6 → `"SOCKS5 [2001:db8::1]:1080"`; при заданном пароле в тексте нет `@` и `s3cret`; пустой список даёт только `DIRECT`; домен с кавычкой не ломает скрипт.
- [ ] `npm test` → FAIL.
- [ ] Реализация: массив доменов фильтруется по строкам, эмитится `var list = <JSON.stringify(list)>;`, цикл с `host === list[i] || dnsDomainIs(host, "." + list[i])`, возврат `JSON.stringify(target)`, иначе `"DIRECT"`, где `target = (scheme === "socks5" ? "SOCKS5" : "PROXY") + " " + endpoint`. Перед сборкой — проверка `target.includes("@")`.
- [ ] `npm test` → PASS.
- [ ] Commit: `feat: генерация PAC с fail-closed маршрутизацией`.

---

### Task 4: Тексты ошибок прокси

**Files:** create `lib/errors.js`, `test/errors.test.js`

**Interfaces:** производит `readErrorCode(rawError)->string` (`ERR_*` или `""`), `describeProxyError(rawError, {endpoint}) -> {code, title, detail} | null`.

- [ ] Тест: `readErrorCode("net::ERR_PROXY_CONNECTION_FAILED") === "ERR_PROXY_CONNECTION_FAILED"`, голый `ERR_TIMED_OUT` проходит, произвольный текст и `""` → `""`; `describeProxyError("net::ERR_PROXY_CONNECTION_FAILED",{endpoint:"1.2.3.4:8080"})` даёт title со словом «не отвечает» и detail с endpoint; все коды из таблицы спеки имеют непустые title/detail; `ERR_NAME_NOT_RESOLVED`, `ERR_CONNECTION_REFUSED`, `""` → `null`.
- [ ] `npm test` → FAIL.
- [ ] Реализация: словарь `Map` с ключами `ERR_PROXY_CONNECTION_FAILED`, `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_SOCKS_CONNECTION_FAILED`, `ERR_SOCKS_CONNECTION_HOST_UNREACHABLE`, `ERR_PROXY_AUTH_UNSUPPORTED`, `ERR_PROXY_AUTH_REQUESTED_WITH_NO_CONNECTION`, `ERR_CONNECTION_TIMED_OUT`, `ERR_TIMED_OUT`, `ERR_MANDATORY_PROXY_CONFIGURATION_FAILED`; шаблон detail содержит `{endpoint}`, подстановка через `replace`, при отсутствии endpoint — слово «прокси».
- [ ] `npm test` → PASS.
- [ ] Commit: `feat: тексты ошибок прокси для страницы сбоя`.

---

### Task 5: Нормализация конфигурации

**Files:** create `lib/config.js`, `test/config.test.js`

**Interfaces:** производит `DEFAULT_CONFIG` (`{version:1, proxy:null, domains:[], lastError:null}`), `normalizeConfig(raw) -> config`. Потребляет `normalizeDomain`, `validateProxy`.

- [ ] Тест: `null` и `"nope"` → дефолт; `domains: ["WWW.B.com","a.com","b.com","a.com","",42]` → `["a.com","b.com"]`; прокси со схемой `https` и socks5 с кредами → `proxy === null`; валидный прокси и `lastError:"boom"` сохраняются, `version === 1`.
- [ ] `npm test` → FAIL.
- [ ] Реализация: `normalizeProxy` приводит `scheme` к `socks5|http`, host к lowercasе, port к `Number`, креды к строкам и возвращает `null`, если `validateProxy` вернул текст; `normalizeConfig` дедуплицирует и сортирует домены, `lastError` — непустая строка или `null`.
- [ ] `npm test` → PASS.
- [ ] Commit: `feat: нормализация конфигурации расширения`.

---

### Task 6: Хранилище и применение PAC с откатом

**Files:** create `store.js`, `test/helpers/chrome-stub.js`, `test/store.test.js`

**Interfaces:** производит `STORAGE_KEY="config"`, `loadConfig()`, `saveConfig(config)`, `applyConfig(config)->{applied, error}`, `commitConfig(next)->{ok, config, error}`, `recordError(message)`, `getProxyControl()`, `invalidateConfigCache()`.

- [ ] `test/helpers/chrome-stub.js`: `createChromeStub(initial)` с `storage.local.get/set` (Map + `structuredClone`), `proxy.settings.get/set/clear`, счётчиками `calls.set/calls.clear`, методами `failNextSet(message)` и `setLevelOfControl(level)`.
- [ ] Тест: пустое хранилище → дефолт; `applyConfig` с пустым списком вызывает `clear({scope:"regular"})` и не вызывает `set`; с непустым — `set` c `value.mode === "pac_script"`, `pacScript.mandatory === true`, в `data` есть `PROXY 1.2.3.4:8080` и нет пароля, `scope === "regular"`; ошибка `set` возвращается как `{applied:false,error}`, не бросается; `commitConfig` после успешного сохранения при падении `set` возвращает `ok:false`, `lastError` с текстом ошибки и **прежний** список доменов (и повторное `loadConfig` это подтверждает); `getProxyControl` возвращает `levelOfControl`.
- [ ] `npm test` → FAIL.
- [ ] Реализация: кэш конфига на модуль, сбрасывается `invalidateConfigCache()`; `loadConfig` читает `storage.local.get(STORAGE_KEY)` и нормализует; `saveConfig` нормализует, пишет, обновляет кэш; `applyConfig` в `try/catch`: без прокси или с пустым списком — `clear`, иначе `set` PAC; `commitConfig` запоминает предыдущий конфиг, сохраняет, применяет, при ошибке сохраняет `{...previous, lastError}` и повторно применяет предыдущий PAC, при успехе чистит `lastError`.
- [ ] `npm test` → PASS.
- [ ] Commit: `feat: хранилище конфигурации и применение PAC с откатом`.

---

### Task 7: Манифест и service worker

**Files:** create `manifest.json`, `background.js`, `test/background.test.js`

**Interfaces:** потребляет `lib/domains.js`, `lib/proxy.js`, `lib/errors.js`, `store.js`. Экспортирует для тестов `hostFromUrl(url)`, `updateBadge(tab)`, `handleToggle(tab)`, `handleProxyFailure(details)`.

- [ ] `manifest.json`: MV3; `minimum_chrome_version: "108"`; права `proxy`, `webRequest`, `webRequestAuthProvider`, `storage`; `host_permissions: ["<all_urls>"]`; `background: {service_worker: "background.js", type: "module"}`; `action.default_title`; `options_ui: {page: "options.html", open_in_tab: true}`; команда `toggle-site` с `Ctrl+Shift+Y` / `Command+Shift+Y` и описанием на русском.
- [ ] `test/background.test.js`: поднять `globalThis.chrome` из стаба, дополнив `action`, `commands`, `tabs`, `webRequest`, `runtime`, `proxy.onProxyError`, `storage.onChanged`; импортировать `background.js` с уникальным query-суффиксом. Проверки: зарегистрировано по одному слушателю клика и команды, `onAuthRequired` получил filter `{urls:["<all_urls>"]}` и `["asyncBlocking"]`; клик по `https://www.example.com/page` пишет в storage `domains: ["example.com"]`, вызывает один `set` и `tabs.reload(7)`; повторный клик по `https://a.example.com/` при `domains: ["example.com"]` даёт пустой список и `clear`; `chrome://settings/` не вызывает ни `set`, ни `reload`; `onAuthRequired` отдаёт `{authCredentials:{username,password}}` при `isProxy:true` и покрытом хосте, `{}` при `isProxy:false` и `{}` для непокрытого хоста.
- [ ] `npm test` → FAIL.
- [ ] Реализация `background.js`: константы `ERROR_PAGE="proxy-error.html"`, цвета `#188038`/`#d93025`, `errorTabs = new Set()`; `hostFromUrl` через `new URL(...).hostname` + `normalizeDomain` с fallback на lowercase hostname; `updateBadge` ставит `ON`+зелёный+title с маскированным endpoint и правилом либо чистит badge и пишет title про прямой доступ; `handleToggle` возвращает `{ok:false,error:"unsupported-url"}` для не-http, иначе `commitConfig` с `toggleDomain`; при ошибке — красный `!`, без reload; при успехе — `tabs.reload` и `{ok:true, proxied}`; `handleProxyFailure` фильтрует `tabId<0`, `type!=="main_frame"`, отсутствие прокси, неизвестный код, непокрытый хост и вкладку уже не на http, затем ставит красный `!` и делает `tabs.update` на `chrome.runtime.getURL(ERROR_PAGE)` с `URLSearchParams({url, code})`.
- [ ] Слушатели на верхнем уровне: `action.onClicked` → `void handleToggle(tab)`; `commands.onCommand` при `toggle-site` берёт переданный `tab` или активную вкладку; `webRequest.onAuthRequired` с `asyncBlocking` отдаёт креды только при `details.isProxy && covered && proxy.scheme === "http" && proxy.username`, иначе `callback({})`; `webRequest.onErrorOccurred` → `void handleProxyFailure`; `webRequest.onCompleted` для `main_frame` снимает флаг ошибки и обновляет badge; `tabs.onActivated`/`tabs.onUpdated(complete)` обновляют badge; `storage.onChanged` для `local`/`STORAGE_KEY` сбрасывает кэш и обновляет badge всех вкладок; `proxy.onProxyError` при `fatal` пишет `recordError`; `runtime.onInstalled`/`onStartup` вызывают `bootstrap()`, который применяет PAC из хранилища и записывает ошибку применения в `lastError`.
- [ ] `npm test` → PASS.
- [ ] Commit: `feat: service worker с переключением прокси, badge и авторизацией`.

---

### Task 8: Страница настроек

**Files:** create `lib/options-model.js`, `test/options-model.test.js`, `options.html`, `options.css`, `options.js`

**Interfaces:** производит `buildProxyPatch(config, form) -> {ok:true, config, notice} | {ok:false, error}`, `form = {scheme, address, username, password}`.

- [ ] Тест: валидный адрес сохраняет прокси, чистит `lastError`, не трогает `domains`; `u:p@1.2.3.4:8080` переносит креды и возвращает `notice`; адрес без порта → `ok:false` с ошибкой про порт и без поля `config`; socks5 с кредами → `ok:false` с текстом про SOCKS5.
- [ ] `npm test` → FAIL.
- [ ] Реализация `lib/options-model.js`: вызвать `parseProxyInput(form.address, {scheme, username, password})`, при ошибке вернуть `{ok:false, error}`, иначе `{ok:true, config: normalizeConfig({...config, proxy, lastError:null}), notice}`.
- [ ] `options.html`: карточки «Прокси-сервер» (`select#scheme`, `input#address`, `input#username`, `input#password`, `button#save-proxy`, `span#proxy-status`, `p#socks-hint`), «Добавить сайт» (`input#domain-input`, `button#add-domain`, `p#domain-status`), «Сайты через прокси» (`ul#domain-list`), «Состояние» (`p#control-banner`, `p#error-banner`, `dd#current-proxy`, `dd#domain-count`), подключение `options.js` как модуля. `options.css`: системный шрифт, `color-scheme: light dark`, карточки с рамкой, сетка формы 90px/1fr, стили `.status`, `.status.error`, `.banner`, `.banner.error`, `.empty`, кнопки `.danger`.
- [ ] `options.js`: при `scheme === "socks5"` блокировать и очищать поля кредов и показывать `#socks-hint`; `render()` заполняет адрес из `formatProxyEndpoint(config.proxy)` (без логина), схему, логин, оставляет пароль пустым с placeholder «сохранён (оставьте пустым, чтобы не менять)», выводит маскированный endpoint, число доменов, `lastError`; список рендерится через `textContent` и `createElement` (никакого `innerHTML`), у каждого элемента кнопка «Удалить» через `commitConfig`; сохранение прокси вызывает `buildProxyPatch`; добавление сайта использует `domainFromInput`, отвергает дубль и пустое значение; `renderControl()` показывает баннер, если `levelOfControl` не `controllable_by_this_extension` и не `controlled_by_this_extension`.
- [ ] `node --check options.js && npm test` → без вывода ошибок, PASS.
- [ ] Commit: `feat: страница настроек с прокси, списком сайтов и предупреждениями`.

---

### Task 9: Страница сбоя прокси

**Files:** create `lib/error-page.js`, `test/proxy-error-page.test.js`, `proxy-error.html`, `proxy-error.js`

**Interfaces:** производит `parseErrorPageQuery(search) -> {targetUrl, code}`; страница потребляет `describeProxyError`, `maskProxyEndpoint`, `loadConfig`.

- [ ] Тест: `?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&code=ERR_PROXY_CONNECTION_FAILED` → полный URL и код; `javascript:`/`chrome-extension:`/пустой `url` → `targetUrl === ""`; `http://example.com` проходит; `code=%3Cscript%3E` → `""`, `ERR_TIMED_OUT` проходит.
- [ ] `npm test` → FAIL.
- [ ] Реализация `lib/error-page.js`: `URLSearchParams`, `new URL`, разрешены только `http:`/`https:`, код валидируется `/^ERR_[A-Z0-9_]+$/`.
- [ ] `npm test` → PASS.
- [ ] `proxy-error.html`: тот же `options.css` плюс локальные стили (`.error-title`, `.error-detail`, `.error-endpoint`, `.actions`), заголовок `h1#error-heading`, `p#error-detail`, `p#error-endpoint`, `button#retry`, `button#open-options`, модульный `proxy-error.js`.
- [ ] `proxy-error.js`: разобрать query, загрузить конфиг, получить маскированный endpoint, `describeProxyError`; заголовок «Не удалось открыть <host> через прокси» (или без хоста), detail причины или «Причина неизвестна.», строка «Прокси: <endpoint>»; всё через `textContent`; `#retry` отключена без валидной цели, иначе `location.replace(targetUrl)`; `#open-options` вызывает `chrome.runtime.openOptionsPage()`; кнопки «открыть напрямую» нет.
- [ ] `node --check proxy-error.js && npm test` → PASS.
- [ ] Commit: `feat: страница с причиной сбоя прокси и кнопкой повтора`.

---

### Task 10: E2E в реальном Chrome

**Files:** create `dev/cdp.mjs`, `dev/e2e.mjs`

**Interfaces:** `npm run test:e2e` завершается кодом 0 и печатает `E2E OK`.

- [ ] `dev/cdp.mjs`: класс `Cdp` с `static connect(wsUrl)`, `send(method, params, sessionId)` (сопоставление по `id`), `waitFor(method, sessionId, timeoutMs)` (очередь ожидающих, `setTimeout` только как таймаут ожидания события), `close()`, обработкой `close`-события с отклонением висящих промисов.
- [ ] `dev/e2e.mjs`: поднять `upstream` (отдаёт `direct-ok`) и `proxy` (логирует `req.url`, отдаёт `proxied-ok`; на `connect` пишет `CONNECT <host>` и отвечает 502) на случайных портах `127.0.0.1`; определить свободный «закрытый» порт (listen + close); запустить Chrome с `--user-data-dir=<tmp>`, `--load-extension=<repo>`, `--disable-extensions-except=<repo>`, `--no-first-run`, `--no-default-browser-check`, `--remote-debugging-port=0`, `--host-resolver-rules=MAP target.test 127.0.0.1, MAP control.test 127.0.0.1`, `--headless=new` (при `HEADLESS=0` — без него); дождаться `DevToolsActivePort` с дедлайном 30 с.
- [ ] Подключиться к browser WS из `/json/version`, `Target.setDiscoverTargets`, дождаться `targetCreated` с `chrome-extension://` и взять id расширения; открыть `options.html` через `Target.createTarget({url:"about:blank"})` + `attachToTarget(flatten)` + `Page.enable` + `Page.navigate` с ожиданием `Page.loadEventFired`; в контексте страницы вызвать `import("./store.js").then(m => m.commitConfig(cfg))` — тот же путь применения PAC, без гонки со `storage.onChanged`.
- [ ] Сценарий A: `commitConfig` с прокси на порт фейкового прокси и `domains:["target.test"]`; открыть `http://target.test:<upstreamPort>/` → `document.body.innerText` содержит `proxied-ok`, лог прокси содержит `target.test`; открыть `http://control.test:<upstreamPort>/` → текст `direct-ok`, в логе прокси нет `control.test` (доказательство, что fail-closed не сломан и лишнее не проксируется).
- [ ] Сценарий B: переключить прокси на закрытый порт тем же `commitConfig`; открыть `http://target.test:<upstreamPort>/`, дождаться `Page.loadEventFired` и разветвления на нашу страницу; проверить `location.href` начинается с `chrome-extension://<id>/proxy-error.html`, `document.body.innerText` содержит адрес `127.0.0.1:<closedPort>` и не содержит пароля.
- [ ] Очистка в `finally`: `Browser.close`, kill процесса, закрыть серверы, `rm -rf` временного профиля; при падении печатать `stderr` Chrome. Если headless-режим не поднимет расширение — README фиксирует запуск `xvfb-run -a node dev/e2e.mjs` после `HEADLESS=0 node dev/e2e.mjs`.
- [ ] `npm run test:e2e` → `E2E OK`.
- [ ] Commit: `test: e2e-проверка проксирования и страницы сбоя в реальном Chrome`.

---

### Task 11: README и финальная проверка

**Files:** create `README.md`

- [ ] `README.md`: установка (chrome://extensions → режим разработчика → «Загрузить распакованное» → корень репозитория), использование (иконка/`Ctrl+Shift+Y`, страница настроек), формат адреса прокси, ограничения (пароль в `storage.local` открытым текстом; SOCKS5 без авторизации; после сбоя в адресной строке `chrome-extension://`; прокси на весь профиль; политика/другое расширение может блокировать настройку), команды `npm test` и `npm run test:e2e`, переменная `CHROME_BIN`.
- [ ] `npm test && node --check background.js && node --check options.js && node --check proxy-error.js` → PASS и без синтаксических ошибок.
- [ ] Commit: `docs: README с установкой и ограничениями`.

---

## Самопроверка плана

- **Покрытие спеки:** §2 UX → Task 7; §3 решения → Task 3/6; §5 манифест → Task 7; §6 модель → Task 5/6; §7 разбор прокси → Task 2; §8 PAC → Task 3/6; §9 точки входа → Task 7; §10 сбой → Task 9 + Task 7 (`handleProxyFailure`); §11 настройки → Task 8; §12 ограничения → Task 11; §14 тесты → Tasks 1-10; §15 критерии → Task 10/11.
- **Плейсхолдеры:** нет TBD/TODO; каждый шаг называет файл, поведение и проверку.
- **Согласованность имён:** `loadConfig`/`saveConfig`/`applyConfig`/`commitConfig`/`recordError`/`getProxyControl`/`invalidateConfigCache`/`STORAGE_KEY` — единые во всех задачах; `normalizeDomain`/`domainFromInput`/`findCoveringRule`/`toggleDomain`; `parseProxyInput`/`validateProxy`/`formatProxyEndpoint`/`maskProxyEndpoint`; `buildPacScript`; `describeProxyError`/`readErrorCode`; `normalizeConfig`/`DEFAULT_CONFIG`; `buildProxyPatch`; `parseErrorPageQuery`; `hostFromUrl`/`updateBadge`/`handleToggle`/`handleProxyFailure`.
