---
title: "XHTTP и selfsteal: рецепт, на котором сидят с конца 2025"
lede: "Вместо чужого SNI свой домен с настоящим сайтом, вместо голого TCP транспорт, который выглядит как обычный HTTP. Собираем связку Xray + Caddy и разбираем, что в ней ломалось."
category: panels
weight: 4
actual: "Xray-core 26.3.27 (последний стабильный релиз) и пре-релизы до 26.9.9 (по официальному репозиторию на 2026-09-24); Caddy 2.x; опыт сообщества до 23.08.2026"
lastmod: 2026-09-24
---

В ноябре 2025 года, после волны отвалов VLESS+Reality, крупные сервисы в сообществе массово пересели на XHTTP со своим SNI. В чате писали, что рецепт «воскрешает всё», и мигрировали по 70 тысяч пользователей ([база](/baza/transporty/xhttp/)). Ниже устройство связки по документации Xray и Caddy и хроника того, что с ней происходило потом.

> [!WARNING]
> Рецепты обхода в РФ живут 1–3 месяца. XHTTP с selfsteal тоже не вечен: в 2026 году ломались и сами поля XHTTP, и клиенты. Перед настройкой сверься с [хронологией блокировок](/baza/tspu/hronologiya/) и [итогом на 23.08.2026](/baza/tspu/itogi/). Основы Reality (ключи, shortId, fingerprint) разобраны в гайде [VLESS + Reality](/gaidy/vless-reality/).

## Что такое XHTTP

XHTTP: транспорт Xray поверх обычного HTTP (H1, H2, H3). Отдельной страницы полей в официальной документации нет: она ссылается на обсуждение разработчиков [XHTTP: Beyond REALITY](https://github.com/XTLS/Xray-core/discussions/4113). Оттуда главное.

**Режимы** (`mode`):

- `packet-up`: исходящий трафик нарезается на отдельные `POST`, входящий идёт одним потоковым `GET`. Самый совместимый режим: проходит почти через любой CDN и реверс-прокси.
- `stream-up`: исходящий трафик тоже потоковый, одним длинным `POST`, входящий по-прежнему отдельным `GET`. По умолчанию притворяется gRPC (`Content-Type: application/grpc`).
- `stream-one`: один `POST`, в котором идут оба направления.
- `auto` (по умолчанию): клиент выбирает `stream-up` для TLS с H2, `stream-one` для Reality и `packet-up` в остальных случаях. Сервер в `auto` принимает все три режима. Если на сервере указан конкретный режим, он принимает только его (исключение: `stream-up` принимает ещё и `stream-one`).

**Что включено по умолчанию:** случайная длина заголовков (`xPaddingBytes`, 100–1000 байт), мультиплексирование XMUX со случайными лимитами. При Reality клиент по умолчанию работает по H2.

Совет разработчика для старта: с TLS и с Reality **заполняй только `path`**, остальное оставь по умолчанию. Ещё два правила из того же обсуждения: не включай `mux.cool` вместе с XHTTP, а флоу `xtls-rprx-vision` на XHTTP не нужен (по документации VLESS XTLS работает только в связке RAW + TLS/Reality).

## Зачем selfsteal

Классический Reality «одалживает» чужой сайт: нода в хостинге, а SNI `www.amd.com`. Сама документация Xray называет лучшей практикой сайт из той же ASN, что и нода, а с чужим SNI это почти никогда не выполняется.

Selfsteal снимает противоречие: у тебя свой домен с A-записью на IP ноды, на ноде настоящий сайт с настоящим сертификатом. В `target` Reality указывает не на чужой сайт, а на локальный веб-сервер. Сканер, пришедший на `:443`, получает твой сертификат и твою страницу. Так выглядит любой сайт на VPS.

Что говорило сообщество:

- 16.09.2025: маскироваться нужно под свой сайт, иначе первый же запрос может стоить IP ([база](/baza/transporty/selfsteal/)).
- 06.06.2026: эксперимент, где с чужим SNI сервер банили почти сразу, а с selfsteal не трогали. Автор оговорился, что это не панацея ([база](/baza/tspu/detekt-fingerprint/)).

{{< compare bad="Reality с чужим SNI" good="Selfsteal со своим доменом" >}}
`target: "www.amd.com:443"`. Сертификат и страница чужие, IP ноды к ним отношения не имеет. Если забанят популярный SNI, лягут все ноды с ним.
---
`target: "127.0.0.1:9443"`. Домен твой, A-запись на ноду, публичный сертификат, на `:443` отвечает реальный сайт. Поменять домен можно без чужого разрешения.
{{< /compare >}}

## Схема

На `:443` слушает Xray. Проверенные клиенты Reality попадают в XHTTP-inbound, всё остальное Xray пересылает в Caddy на `127.0.0.1:9443` вместе с заголовком PROXY protocol, чтобы Caddy видел настоящий IP посетителя.

{{< flow caption="Selfsteal: всё, что не прошло проверку Reality, получает сайт от Caddy. Порт 9443 взят из шаблона сообщества" >}}
Сканер или браузер
!Xray `:443` | SNI твой домен
Fallback Reality | не прошла
Caddy `127.0.0.1:9443` | PROXY + TLS
{{< /flow >}}

## Caddy

Caddyfile собран по шаблону из базы ([Docker Compose](/baza/paneli/docker-compose/), [реверс-прокси](/baza/set/reverse-proxy/)) и сверен с документацией Caddy:

```text {name="Caddyfile"}
{
	https_port 9443
	default_bind 127.0.0.1
	servers {
		listener_wrappers {
			proxy_protocol {
				allow 127.0.0.1/32
			}
			tls
		}
	}
	auto_https disable_redirects
}

http://ВСТАВЬ_ДОМЕН {
	bind 0.0.0.0
	redir https://ВСТАВЬ_ДОМЕН{uri} permanent
}

https://ВСТАВЬ_ДОМЕН {
	root * /var/www/html
	try_files {path} /index.html
	file_server
}

:9443 {
	tls internal
	respond 204
}
```

Разбор:

- `https_port 9443` и `default_bind 127.0.0.1`: HTTPS-сайты Caddy слушают только локальный `9443`. Порт 443 занят Xray.
- `listener_wrappers`: `proxy_protocol` должен стоять **до** `tls`, потому что заголовок PROXY идёт открытым текстом перед рукопожатием. `allow` задаёт доверенные адреса.
- `http://…` с `bind 0.0.0.0`: единственное, что Caddy открывает в мир, это порт 80. Через него идёт HTTP-проверка Let's Encrypt (документация Caddy требует, чтобы порт 80 был доступен снаружи) и редирект на HTTPS. Без явного `http://`-сайта `default_bind` на автоматически созданный сервер редиректов не распространяется, об этом отдельно предупреждает документация.
- `auto_https disable_redirects`: автоматические редиректы выключены, вместо них наш явный блок.
- `:9443 { tls internal … }`: заглушка на запросы с чужими именами.
- В `/var/www/html` положи настоящий сайт. Пустая страница или дефолтный «It works!» маскировку не улучшат.

В сообществе Caddy для selfsteal запускают в Docker с `network_mode: host` (пример `caddy:2.9.1`, [база](/baza/paneli/docker-compose/)). Про выпуск сертификатов и проверку продления есть гайд [TLS-сертификаты](/gaidy/tls-sertifikaty/).

## Inbound XHTTP + Reality

```json {name="config.json"}
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "tag": "VLESS_XHTTP_REALITY",
      "listen": "0.0.0.0",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [
          { "id": "ВСТАВЬ_UUID", "email": "user1" }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "xhttp",
        "security": "reality",
        "xhttpSettings": {
          "path": "/ВСТАВЬ_ПУТЬ"
        },
        "realitySettings": {
          "show": false,
          "target": "127.0.0.1:9443",
          "xver": 1,
          "serverNames": ["ВСТАВЬ_ДОМЕН"],
          "privateKey": "ВСТАВЬ_PRIVATE_KEY",
          "shortIds": ["ВСТАВЬ_SHORT_ID"]
        }
      }
    }
  ],
  "outbounds": [
    { "tag": "direct", "protocol": "freedom" }
  ]
}
```

- `network: "xhttp"`: Reality по документации совместим с RAW, XHTTP и gRPC.
- `xhttpSettings.path`: должен совпадать у сервера и клиента. `mode` не задан, значит `auto`: сервер принимает все режимы.
- `host` на сервере лучше не задавать: если он указан, сервер сверяет его с присланным клиентом. Разработчик советует без нужды его не трогать.
- `target: "127.0.0.1:9443"`: локальный Caddy вместо чужого сайта.
- `xver: 1`: Xray отправляет в Caddy заголовок PROXY protocol. **Настройки должны совпадать с обеих сторон**: `xver: 1` требует `proxy_protocol` в Caddy, а без этого блока в Caddyfile ставь `xver: 0`.
- `serverNames`: твой домен, тот же, что в Caddyfile.
- Флоу у клиента не указан: Vision к XHTTP не относится.

> [!IMPORTANT]
> DNS: A-запись домена должна указывать на IP ноды. Если включить проксирование Cloudflare (оранжевое облако), клиент с адресом-доменом придёт в Cloudflare, который завершает TLS сам, и до Reality на ноде не доберётся. Для selfsteal держи серое облако.

## Клиент

```json {name="client.json"}
{
  "outbounds": [
    {
      "tag": "proxy",
      "protocol": "vless",
      "settings": {
        "address": "ВСТАВЬ_ДОМЕН",
        "port": 443,
        "id": "ВСТАВЬ_UUID",
        "encryption": "none"
      },
      "streamSettings": {
        "network": "xhttp",
        "security": "reality",
        "xhttpSettings": {
          "path": "/ВСТАВЬ_ПУТЬ",
          "mode": "auto"
        },
        "realitySettings": {
          "serverName": "ВСТАВЬ_ДОМЕН",
          "fingerprint": "chrome",
          "password": "ВСТАВЬ_PUBLIC_KEY",
          "shortId": "ВСТАВЬ_SHORT_ID"
        }
      }
    }
  ]
}
```

С Reality `auto` на клиенте означает `stream-one`. Чтобы убедиться, какой режим, версия HTTP и `host` реально используются, разработчик советует поднять логи клиента до `info`.

Какие приложения это тянут, по [базе клиентов](/baza/transporty/klienty/):

- **Happ** и **INCY**: основные. Отзыв 27.06.2026: «сносно работает сразу везде ща только Happ и INCY».
- **v2rayN** на ПК, по отзыву 24.06.2026, часто единственный, кто работает.
- **mihomo (Clash)**: поддержка XHTTP на 16.06.2026 в альфе, 03.07.2026 у пользователя vless+xhttp+tls не заработал. В ноябре 2025 отсутствие XHTTP в Mihomo/Clash называли главным минусом рецепта.

## Проверка

С машины вне ноды:

```bash
curl -sI https://ВСТАВЬ_ДОМЕН/        # ждём 200 от твоего сайта
xray tls ping ВСТАВЬ_ДОМЕН           # TLS 1.3 и публичный сертификат на твой домен
```

Если вместо сайта ошибка рукопожатия, проверь пару `xver` и `proxy_protocol` и то, что Caddy действительно слушает `127.0.0.1:9443` (`ss -ltnp | grep 9443`).

## Что ломалось по датам

| Дата | Что произошло |
|---|---|
| 23–26.11.2025 | Массовый переезд на XHTTP + свой SNI, рост скорости у многих, работает на iPhone. Минус: Mihomo/Clash не поддерживают |
| 08.12.2025 | Шаблон Caddy на два порта для TCP- и XHTTP-selfsteal на одной ноде ([база](/baza/set/reverse-proxy/)) |
| ~02.04.2026 | Когда банили TCP, на XHTTP «сразу заработало и почти без потери скорости» |
| 27.04.2026 | Отзывы, что XHTTP в проде встречается редко, основа у большинства TCP; жалобы на отключение интернета на iPhone |
| 06–07.06.2026 | Хорошо настроенный XHTTP на Yandex Cloud живёт дольше TCP+Reality; Happ dev-ветка 16 часов без проблем на XHTTP Reality на iOS, но кто-то вернулся на TCP |
| 09.06.2026 | В Xray-core смержен [PR #6258](https://github.com/XTLS/Xray-core/pull/6258): поля `session*` переименованы в `sessionID*` (`sessionKey` → `sessionIDKey`, `sessionPlacement` → `sessionIDPlacement`). В чате 15–24.06 жаловались, что старые XHTTP+CDN конфиги на новом ядре не работают |
| 13.07.2026 | Новый Happ для iOS отправляет только часть ID-параметров, сервер пишет `stream-one mode is not allowed`. Лечили полным набором ID-параметров в конфиге |
| 14.07.2026 | Xray 26.7.11: клиент стал отправлять `/poll?offset=…` вместо `/poll/?offset=…`. INCY ругался на путь, помогал `/` в конце `path` |

Источник таблицы: [XHTTP](/baza/transporty/xhttp/), [вехи](/baza/transporty/vehi/), [ошибки → фиксы](/baza/transporty/oshibki-fiksy/), [детект](/baza/tspu/detekt-fingerprint/).

> [!TIP]
> Из истории 2026 года вывод простой: ядро на ноде и ядра в клиентах пользователей обновляются несинхронно, а поля XHTTP менялись несовместимо. Перед обновлением Xray на ноде проверь, какое ядро в Happ и INCY у твоих пользователей, и держи откат. Процедура в гайде [Обновления без поломок](/gaidy/obnovleniya-bez-polomok/), подключение профиля к ноде в [Нода Remnawave](/gaidy/noda-remnawave/).

## Источники

- Xray-core, обсуждение разработчиков [XHTTP: Beyond REALITY (#4113)](https://github.com/XTLS/Xray-core/discussions/4113); [PR #6258](https://github.com/XTLS/Xray-core/pull/6258); исходник `infra/conf/transport_internet.go` (список режимов XHTTP, алиасы полей), теги v26.3.27 и v26.9.9
- Документация Xray: [REALITY](https://xtls.github.io/en/config/transports/reality.html), [VLESS inbound](https://xtls.github.io/en/config/inbounds/vless.html), [VLESS outbound](https://xtls.github.io/en/config/outbounds/vless.html), [fallbacks (xver)](https://xtls.github.io/en/config/features/fallback.html), [Transport](https://xtls.github.io/en/config/transport.html)
- README [XTLS/REALITY](https://github.com/XTLS/REALITY/blob/main/README.en.md)
- Документация Caddy: [глобальные опции](https://caddyserver.com/docs/caddyfile/options) (`https_port`, `default_bind`, `listener_wrappers`, `proxy_protocol`, `auto_https`), [Automatic HTTPS](https://caddyserver.com/docs/automatic-https) (HTTP-проверка через порт 80)
- База host.pink: [XHTTP](/baza/transporty/xhttp/), [Selfsteal](/baza/transporty/selfsteal/), [Клиенты](/baza/transporty/klienty/), [Вехи](/baza/transporty/vehi/), [Ошибки → фиксы](/baza/transporty/oshibki-fiksy/), [Docker Compose](/baza/paneli/docker-compose/), [Реверс-прокси](/baza/set/reverse-proxy/), [Детект и fingerprint](/baza/tspu/detekt-fingerprint/), [Хронология](/baza/tspu/hronologiya/), [Итог на 23.08.2026](/baza/tspu/itogi/)
