---
title: "VLESS + Reality: как работает и как настроить"
lede: "Reality выдаёт твою ноду за чужой сайт так убедительно, что наблюдатель видит настоящий сертификат. Разбираем, как это устроено, какие поля нужны серверу и клиенту и почему в РФ рецепт каждые пару месяцев приходится обновлять."
category: panels
weight: 3
actual: "Xray-core 26.3.27 (последний стабильный релиз) и пре-релизы до 26.9.9 (по официальному репозиторию на 2026-09-24); опыт сообщества до 23.08.2026"
lastmod: 2026-09-24
---

Reality часто настраивают копипастой из чата: подставили чужой `serverNames`, сгенерировали ключ, заработало. Через месяц SNI попадает под раздачу, и никто не помнит, какое поле за что отвечало. Ниже то, что написано в официальной документации Xray и README REALITY, плюс что происходило с этим рецептом в России.

> [!WARNING]
> Рецепты обхода блокировок в РФ живут 1–3 месяца. Всё, что ниже помечено датой, это опыт сообщества на указанный день, а не гарантия. Перед настройкой загляни в [хронологию блокировок](/baza/tspu/hronologiya/) и [итог на 23.08.2026](/baza/tspu/itogi/).

## Как работает Reality

По README [XTLS/REALITY](https://github.com/XTLS/REALITY) Reality заменяет TLS на стороне сервера. Сертификат покупать не нужно: сервер указывает на чужой сайт (`target`) и для наблюдателя выглядит как настоящий TLS с этим SNI. Серверный TLS-отпечаток, характерный для прокси, пропадает.

Что происходит при подключении:

1. Клиент отправляет Client Hello с SNI из `serverNames` и спрятанными в нём данными для проверки: ключ x25519 и `shortId`.
2. Если проверка прошла, сервер выдаёт клиенту «временный доверенный сертификат», и внутри идёт VLESS.
3. Если нет (сканер, браузер, чужой клиент), Xray **напрямую пересылает** соединение на `target`. Проверяющий получает настоящий сертификат и настоящую страницу сайта.

Клиент Reality различает три случая: временный сертификат (работаем), настоящий сертификат сайта (включается «режим паука» `spiderX`, клиент ведёт себя как обычный посетитель) и невалидный сертификат (TLS alert, разрыв).

{{< flow caption="Чужой Client Hello на ноде с Reality: проверка не прошла, соединение уходит на настоящий сайт. Прошедший проверку клиент остаётся в Xray. По README XTLS/REALITY" >}}
Сканер или браузер
!Xray `:443` | Client Hello
Проверка ключа | Reality
Сайт `target` | не прошла
{{< /flow >}}

## Ключи и идентификаторы

Все команды встроены в Xray. На ноде в Docker запускай через `docker exec <контейнер> xray ...`.

```bash
xray uuid                        # случайный UUID для клиента
xray uuid -i "любая строка"      # UUIDv5 из строки, одинаковый при каждом запуске
xray x25519                      # пара ключей для Reality
openssl rand -hex 8              # shortId: 16 hex-символов
```

`xray x25519` печатает три строки: `PrivateKey` (в конфиг сервера), `Password (PublicKey)` (клиенту) и `Hash32`. Публичный ключ можно получить заново из приватного: `xray x25519 -i "ПРИВАТНЫЙ_КЛЮЧ"`.

Требования к `shortId`: до 16 символов `0`–`f`, количество символов **чётное**. Короткое значение ядро дополняет нулями справа: `aa1234` превращается в `aa12340000000000`, а `aaa1234` даст ошибку.

## Серверный inbound

Минимальный конфиг ноды с одним клиентом:

```json {name="config.json"}
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "tag": "VLESS_REALITY",
      "listen": "0.0.0.0",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [
          { "id": "ВСТАВЬ_UUID", "flow": "xtls-rprx-vision", "email": "user1" }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "raw",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "target": "ВСТАВЬ_САЙТ:443",
          "xver": 0,
          "serverNames": ["ВСТАВЬ_САЙТ"],
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

Что здесь что:

- `settings.clients[].id`: UUID или любая строка до 30 байт. В свежей документации массив называется `users`, но исходник ядра принимает оба имени.
- `flow: "xtls-rprx-vision"`: режим XTLS Vision. Работает только в связке RAW (TCP) + TLS/Reality. Если на сервере он задан, клиент обязан его включить.
- `decryption: "none"`: пустым оставлять нельзя, для обычного VLESS пишется явно `"none"`.
- `network: "raw"`: бывший `tcp`, переименован. В документации для 26.7+ поле называется `method`. Ядро принимает `network` и `method`, `raw` и `tcp`, поэтому пример выше работает и на стабильной 26.3.27.
- `target`: куда уходят непроверенные соединения. Формат как у `dest` в fallbacks: `адрес:порт` или путь к unix-сокету. Старое имя поля `dest`, сейчас это синонимы. Не указывай `target` в конфиге клиента: по нему ядро решает, серверный это конфиг или клиентский.
- `xver`: отправлять ли на `target` PROXY protocol (0: нет, 1 или 2: да). Для чужого сайта всегда 0. Пригодится с selfsteal, см. [XHTTP и selfsteal](/gaidy/xhttp-selfsteal/).
- `serverNames`: какие SNI сервер примет. Без `*`. Обычно совпадает с именами в сертификате `target`.
- `privateKey`: из `xray x25519`.
- `shortIds`: список допустимых shortId. Пустая строка в списке разрешает клиенту пустой shortId.

> [!NOTE]
> В сообществе 29.09.2025 советовали при отключениях клиентов менять `raw` на `tcp` и `target` на `dest` ([база](/baza/transporty/oshibki-fiksy/)). В актуальном ядре это синонимы (проверено по исходнику `infra/conf`), так что сама по себе такая замена поведение не меняет.

## Клиентская сторона

Клиенты вроде Happ и INCY собирают это из ссылки подписки, но полезно понимать, какие поля за этим стоят. Outbound в формате текущей документации:

```json {name="client.json"}
{
  "outbounds": [
    {
      "tag": "proxy",
      "protocol": "vless",
      "settings": {
        "address": "ВСТАВЬ_IP_НОДЫ",
        "port": 443,
        "id": "ВСТАВЬ_UUID",
        "encryption": "none",
        "flow": "xtls-rprx-vision"
      },
      "streamSettings": {
        "network": "raw",
        "security": "reality",
        "realitySettings": {
          "serverName": "ВСТАВЬ_САЙТ",
          "fingerprint": "chrome",
          "password": "ВСТАВЬ_PUBLIC_KEY",
          "shortId": "ВСТАВЬ_SHORT_ID",
          "spiderX": "/"
        }
      }
    }
  ]
}
```

- `serverName`: один из серверных `serverNames`.
- `password`: публичный ключ сервера. Раньше поле называлось `publicKey`, ядро понимает оба имени. Документация переименовала его, чтобы подчеркнуть: ключ держат у себя клиенты, публиковать его не стоит.
- `shortId`: один из серверных `shortIds`.
- `fingerprint`: какой браузер изображает Client Hello через uTLS. Варианты: `chrome` (по умолчанию), `firefox`, `safari`, `ios`, `android`, `edge`, `360`, `qq`, `random`, `randomized`. Значение `unsafe` в Reality не поддерживается.
- `spiderX`: начальный путь для «режима паука». Документация советует разный для каждого клиента.

## Как выбрать сайт-маскировку

Минимальные требования из README REALITY:

- сайт поддерживает **TLS 1.3 и HTTP/2**;
- домен **не используется для редиректа** (редирект основного домена на `www` допустим; в примере README в `serverNames` указаны оба имени);
- сайт находится «вне GFW». README писали для Китая, по смыслу это сайт, который цензор не блокирует.

Плюсом README называет близость IP сайта к IP ноды и OCSP stapling. Документация Xray говорит прямо: лучшая практика: «одалживать» сертификат у сайта **из той же ASN**, что и нода. Отдельное предупреждение про сайты за Cloudflare: непроверенный трафик уходит на `target`, и после сканирования твоя нода превращается в бесплатный порт-форвардер к Cloudflare.

Проверка кандидата:

```bash
xray tls ping example.com          # версия TLS, сертификат, пост-квантовый обмен
curl -sI --http2 -o /dev/null -w '%{http_version} %{http_code}\n' https://example.com/
```

Нужно увидеть `TLS 1.3` в первом выводе и `2 200` во втором. Код `301` или `302` означает, что домен отдаёт редирект, и для `target` он не годится.

{{< compare bad="Чужой SNI" good="Свой домен (selfsteal)" >}}
Нода в хостинге, SNI `www.amd.com`. IP и ASN не совпадают с настоящим сайтом, сертификат «одолжен». Рабочий SNI могут забанить у всех разом.
---
Нода с твоим доменом, A-запись на IP ноды, настоящий сайт и сертификат на том же сервере. Отличий от обычного сайта в хостинге нет. Подробности в [XHTTP и selfsteal](/gaidy/xhttp-selfsteal/).
{{< /compare >}}

Что ставили в `target` в сообществе: `www.amd.com:443` (30.03.2026), `st.ozone.ru:443` (04.06.2026), `ads.x5.ru:443` с fingerprint `firefox` на российской ноде-мосте (15.06.2026). Все примеры в [базе](/baza/transporty/reality/). Это снимок на дату, а не рекомендация.

> [!CAUTION]
> 23.11.2025 для нескольких регионов с ТСПУ ходил обход `target: "1.1.1.1:443"` и `serverNames: [""]` ([база](/baza/transporty/reality/)). Пустая строка в `serverNames` разрешает подключения без SNI, клиент тогда пишет в `serverName` любой IP. Учти предупреждение документации про сайты за Cloudflare: 1.1.1.1 как раз такой случай.

## Что горело в РФ

Сжато по [хронологии](/baza/tspu/hronologiya/), [детекту отпечатков](/baza/tspu/detekt-fingerprint/) и [SNI и fingerprint](/baza/transporty/sni-fingerprint/):

| Дата | Что произошло |
|---|---|
| 22–25.11.2025 | Массовый отвал VLESS+Reality в регионах (Урал, Сибирь, Крым), блокировка TLS 1.3+ECH и TLS-in-TLS; 24.11 начали снимать. Массовый переезд на XHTTP + свой SNI |
| 20–21.12.2025 | На Мегафоне из ~700 проверенных SNI работало около 70 |
| 25–26.05.2026 | ТСПУ отбрасывает VLESS TCP Reality с fingerprint `chrome`: «пинг есть, но не работает». Меняли на `firefox`, `safari`, `randomized`; `qq` для РФ сочли «максимально палевным» |
| 26–27.05.2026 | Детект по TLS-хендшейку и TLS-in-TLS: смена fingerprint «лечит лишь симптом» |
| 04–05.06.2026 | Активный спуфинг: ТСПУ перехватывает рукопожатие и подсовывает настоящий сертификат сайта-маскировки, клиент рвёт соединение |
| 06.06.2026 | Эксперимент: с чужим SNI сервер банят почти сразу, с selfsteal не трогают, но это не панацея |
| 16.06.2026 | Рабочий `serverNames` забанен, ноды на TCP Reality перестали работать, Hysteria2 и TLS живы |
| 27.06.2026 | Отзыв из чата: «ни один fingerprint не работает» |
| 23.08.2026 | Хосты под ТСПУ-банами банят по /32, а не по /24 |

Спуфинг 04.06 соответствует второму случаю из README: посредник отправил Client Hello на настоящий сайт, клиент получил его сертификат и не стал отправлять данные. Защита отработала как задумано, только соединения от этого нет.

## Reality в Remnawave

В Remnawave серверная часть (inbound выше) живёт в профиле конфигурации ноды. В шаблонах из сообщества `clients` пустой: пользователей подставляет панель. Клиентские параметры вроде fingerprint задаются в хостах, меняются в **Хосты → расширенные настройки** ([база](/baza/tspu/detekt-fingerprint/)). Как завести ноду и привязать к ней профиль, описано в гайде [Нода Remnawave](/gaidy/noda-remnawave/), установка самой панели в [Remnawave с нуля](/gaidy/remnawave-s-nulya/). Перед обновлением ядра на ноде прочитай [Обновления без поломок](/gaidy/obnovleniya-bez-polomok/): в 2026 году поля XHTTP меняли несовместимо, подробности в гайде [XHTTP и selfsteal](/gaidy/xhttp-selfsteal/).

## Источники

- README XTLS/REALITY: [github.com/XTLS/REALITY](https://github.com/XTLS/REALITY/blob/main/README.en.md)
- Документация Xray: [REALITY](https://xtls.github.io/en/config/transports/reality.html), [VLESS inbound](https://xtls.github.io/en/config/inbounds/vless.html), [VLESS outbound](https://xtls.github.io/en/config/outbounds/vless.html), [RAW](https://xtls.github.io/en/config/transports/raw.html), [TLS (fingerprint)](https://xtls.github.io/en/config/transports/tls.html), [fallbacks](https://xtls.github.io/en/config/features/fallback.html); исходники `infra/conf/transport_internet.go`, `infra/conf/vless.go`, `main/commands/all/curve25519.go`, `main/commands/all/tls/ping.go` в [XTLS/Xray-core](https://github.com/XTLS/Xray-core), тег v26.3.27 и ветка main
- База host.pink: [VLESS + Reality](/baza/transporty/reality/), [SNI и fingerprint](/baza/transporty/sni-fingerprint/), [Ошибки → фиксы](/baza/transporty/oshibki-fiksy/), [Детект и fingerprint](/baza/tspu/detekt-fingerprint/), [Хронология блокировок](/baza/tspu/hronologiya/), [Итог на 23.08.2026](/baza/tspu/itogi/)
