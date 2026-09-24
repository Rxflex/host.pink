---
title: "nginx за Cloudflare: SSL, реальный IP и закрытый origin"
lede: "Оранжевое облако включается одной кнопкой. Чтобы за ним не остались редирект-петля, IP Cloudflare в логах и origin, открытый всему интернету, нужно ещё несколько файлов."
category: web
weight: 2
actual: "nginx 1.26, nftables 1.0+, Cloudflare на 2026-09; диапазоны IP сняты 2026-09-23"
lastmod: 2026-09-23
---

Cloudflare-прокси часто включают, чтобы «спрятать сервер». Без настройки origin выходит так: сервер по-прежнему доступен напрямую, в логах сплошь адреса Cloudflare, а после включения HTTPS сайт уходит в бесконечный редирект.

> [!WARNING]
> Сначала о России. По опыту сообщества, IP Cloudflare у части российских операторов недоступны или работают плохо: панель или кабинет за оранжевым облаком из РФ не открывается, а с серым облаком (DNS only) открывается. Примеры: [индекс ошибок](/baza/indeksy/oshibki/), [DNS](/baza/set/dns/). Если твоя аудитория в РФ, сначала проверь домен из нескольких стран через [host.pink/check](https://host.pink/check/example.com), а сам разбор, почему сайт не открывается, есть в гайде [Сайт не открывается из РФ](/gaidy/sayt-ne-otkryvaetsya-iz-rf/).

## Режимы SSL/TLS

В дашборде зоны: **SSL/TLS → Overview**. Режим определяет, как Cloudflare ходит к твоему серверу, а не к посетителю.

| Режим | Посетитель → Cloudflare | Cloudflare → origin | Проверка сертификата origin |
|---|---|---|---|
| Flexible | HTTPS | всегда HTTP | нет |
| Full | HTTPS | тем же протоколом, что и посетитель | никакой: подойдёт самоподписанный, просроченный, на чужое имя |
| Full (strict) | HTTPS | тем же протоколом, что и посетитель | срок действия, издатель (публичный CA или Cloudflare Origin CA), совпадение имени в CN/SAN |

### Почему Flexible — зло

1. **Редирект-петля.** Cloudflare приходит на origin по HTTP. Если на origin стоит `return 301 https://…`, nginx отправляет Cloudflare на HTTPS, Cloudflare снова идёт по HTTP, и так без конца. Документация Cloudflare прямо называет это причиной недоступности сайта.
2. **Открытый HTTP до origin.** Замочек в браузере есть, но участок Cloudflare → сервер идёт открытым текстом. Сама Cloudflare не рекомендует Flexible для логинов и персональных данных. Панель с паролем администратора как раз такой случай.

Full лучше, но тоже не защищает: раз сертификат не проверяется, «подсунуть свой сертификат» на этом участке технически возможно. Рабочий вариант один: **Full (strict)**. Редирект с HTTP на HTTPS Cloudflare советует делать на своей стороне (принудительный HTTPS на edge), а не на origin.

## Сертификат на origin

Для Full (strict) подойдёт любой публично доверенный сертификат (Let's Encrypt и т. п., см. [Сертификаты](/baza/set/sertifikaty/) и гайд [TLS-сертификаты](/gaidy/tls-sertifikaty/)) или **Cloudflare Origin CA**: **SSL/TLS → Origin Server → Create Certificate**.

Что важно знать про Origin CA:

- Ему доверяет только Cloudflare. Если снять проксирование (серое облако) или поставить Cloudflare на паузу, браузеры увидят недоверенный сертификат.
- Ключ RSA или ECC, для nginx выбирай формат PEM.
- До 200 SAN, wildcard только на один уровень (`*.example.com`), IP-адреса в SAN нельзя.
- Cloudflare **не присылает уведомлений** об истечении Origin CA. Срок отслеживай сам.

> [!CAUTION]
> Учитывая предупреждение про РФ: если есть шанс, что придётся быстро переключить домен на серое облако, Origin CA тебя подведёт. Сертификат Let's Encrypt работает в обоих режимах.

## Реальный IP посетителя

За прокси `$remote_addr` в nginx равен адресу узла Cloudflare. Настоящий адрес Cloudflare передаёт в заголовке `CF-Connecting-IP`, а восстанавливает его модуль `ngx_http_realip_module`. В сборке из исходников он по умолчанию не включён, поэтому сначала проверь:

```bash
nginx -V 2>&1 | grep -o with-http_realip_module
```

Конфиг: доверяем заголовку только от адресов Cloudflare.

```nginx {name="/etc/nginx/conf.d/cloudflare-realip.conf"}
# https://www.cloudflare.com/ips-v4
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
# https://www.cloudflare.com/ips-v6
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;

real_ip_header CF-Connecting-IP;
```

Обе директивы допустимы в контекстах `http`, `server` и `location`; убедись, что `conf.d/*.conf` подключается в `nginx.conf` внутри блока `http`. Исходный адрес узла Cloudflare остаётся доступен в переменной `$realip_remote_addr`, её удобно писать в лог рядом с `$remote_addr`.

> [!IMPORTANT]
> Список выше снят 2026-09-23. Cloudflare меняет диапазоны редко, но меняет, и сама пишет, что список нужно регулярно обновлять. Скрипт автообновления ниже.

## Закрыть origin для всех, кроме Cloudflare

Смысл прокси теряется, если сервер отвечает напрямую: кто узнал IP origin, обходит Cloudflare и все её защиты. Документация Cloudflare советует пропускать на веб-порты только её адреса.

Берём конфиг из гайда [nftables: минимальный файрвол](/gaidy/nftables-minimalnyy-fayrvol/) и добавляем в таблицу `inet filter` два набора, а правило для 80/443 меняем:

```bash {name="/etc/nftables.conf (фрагмент)"}
table inet filter {
  set cf4 { type ipv4_addr; flags interval; }
  set cf6 { type ipv6_addr; flags interval; }

  chain input {
    type filter hook input priority filter; policy drop;
    # ... established, lo, icmp, ssh как в базовом конфиге ...

    # было: tcp dport { 80, 443 } accept
    tcp dport { 80, 443 } ip saddr @cf4 accept
    tcp dport { 80, 443 } ip6 saddr @cf6 accept
  }
}

# элементы наборов генерирует скрипт, файл подключается после объявления таблицы
include "/etc/nftables.d/cloudflare.nft"
```

Скрипт, который скачивает диапазоны и обновляет и nftables, и nginx:

```bash {name="/usr/local/sbin/cf-ips-update"}
#!/bin/sh
set -eu
v4=$(curl -fsS https://www.cloudflare.com/ips-v4)
v6=$(curl -fsS https://www.cloudflare.com/ips-v6)
# пустой ответ не должен превратиться в пустой allowlist
[ -n "$v4" ] && [ -n "$v6" ] || exit 1

mkdir -p /etc/nftables.d
{
  echo "add element inet filter cf4 { $(echo $v4 | tr ' ' ',') }"
  echo "add element inet filter cf6 { $(echo $v6 | tr ' ' ',') }"
} > /etc/nftables.d/cloudflare.nft

# очистка и заполнение в одной транзакции nft -f
printf '%s\n' 'flush set inet filter cf4' 'flush set inet filter cf6' \
  'include "/etc/nftables.d/cloudflare.nft"' > /run/cf-apply.nft
nft -f /run/cf-apply.nft

{
  for n in $v4 $v6; do echo "set_real_ip_from $n;"; done
  echo "real_ip_header CF-Connecting-IP;"
} > /etc/nginx/conf.d/cloudflare-realip.conf
nginx -t && systemctl reload nginx
```

```bash
chmod +x /usr/local/sbin/cf-ips-update && /usr/local/sbin/cf-ips-update
nft list set inet filter cf4
```

Файл, загруженный через `nft -f`, применяется атомарно: момента, когда набор уже очищен, а новые адреса ещё не добавлены, нет. Запускать скрипт раз в сутки удобно через systemd-таймер, как это сделать, описано в гайде [systemd: свои сервисы и таймеры](/gaidy/systemd-servisy/).

> [!WARNING]
> Если nginx живёт в Docker и порты опубликованы через `ports:`, Docker пропускает трафик в обход цепочки `input`, и этот allowlist не сработает. Подробности в [гайде по nftables](/gaidy/nftables-minimalnyy-fayrvol/) и в базе: [Docker](/baza/set/docker/), [Firewall и анти-DDoS](/baza/set/firewall-ddos/).

## Authenticated Origin Pulls (mTLS)

Файрвол проверяет, что запрос пришёл из сети Cloudflare. AOP добавляет криптографическую проверку: Cloudflare предъявляет клиентский сертификат, nginx его проверяет. Варианты:

- **Global**: общий сертификат Cloudflare. Сама документация предупреждает, что он одинаковый для всех аккаунтов и доказывает только то, что запрос пришёл из сети Cloudflare, а не от твоего аккаунта.
- **Zone-level**: свой сертификат, загруженный в зону. Действует только для твоего аккаунта.
- **Per-hostname**: свой сертификат на конкретные имена.

Порядок важен: сначала origin, потом переключатель. Для Global скачай сертификат Cloudflare для AOP по ссылке со страницы Global AOP в документации. Для Zone-level сгенерируй свой через OpenSSL и загрузи в **SSL/TLS → Origin Server → Authenticated Origin Pulls**. Затем в nginx:

```nginx {name="/etc/nginx/sites-enabled/panel.conf (фрагмент)"}
ssl_client_certificate /etc/nginx/certs/cloudflare.crt;
ssl_verify_client optional;   # на время проверки
```

Потом включаешь AOP в дашборде (**Origin Server → Authenticated Origin Pulls**, секция Global или Zone-level → On), проверяешь, что сайт открывается, и ужесточаешь:

```nginx
ssl_verify_client on;
```

Без сертификата nginx ответит кодом 496, при ошибке проверки 495. Обе директивы работают в контекстах `http` и `server`.

## WebSocket и порты

WebSocket через Cloudflare работает на всех тарифах, переключатель находится в **Network → WebSockets**, проверь, что он включён. На стороне nginx нужны заголовки из официального примера:

```nginx {name="/etc/nginx/sites-enabled/panel.conf"}
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name panel.example.com;

    ssl_certificate     /etc/nginx/certs/origin.pem;
    ssl_certificate_key /etc/nginx/certs/origin.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;   # нужно для nginx до 1.29.7
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }
}
```

По умолчанию nginx закрывает проксируемое соединение, если бэкенд молчит 60 секунд, поэтому `proxy_read_timeout` поднят. У Cloudflare свой idle-таймаут, а при выкатке обновлений сети она перезапускает серверы и рвёт WebSocket-соединения. Клиент должен уметь переподключаться, keepalive-пинги тоже помогают.

Cloudflare проксирует не любой порт, а только эти:

| | Порты |
|---|---|
| HTTP | 80, 8080, 8880, 2052, 2082, 2086, 2095 |
| HTTPS | 443, 2053, 2083, 2087, 2096, 8443 |

На 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8880 и 8443 кэширование по умолчанию отключено. Для остальных портов (SSH и прочего) остаётся серое облако или Spectrum. Если открываешь в nftables, например, 8443 для Cloudflare, добавь его в правила с `@cf4`/`@cf6`.

> [!TIP]
> Как устроены реверс-прокси для панелей и ботов в сообществе (nginx, Caddy, haproxy): [Reverse proxy](/baza/set/reverse-proxy/) и [Nginx / Caddy для панели](/baza/paneli/reverse-proxy/). Проверить, что origin не светит лишних портов: [досье IP](https://host.pink/1.1.1.1).

## Источники

- Cloudflare: [Flexible](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/), [Full](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full/), [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
- Cloudflare: [Origin CA certificates](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
- Cloudflare: [Restoring original visitor IPs](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)
- Cloudflare: [IP-адреса](https://www.cloudflare.com/ips/), [ips-v4](https://www.cloudflare.com/ips-v4), [ips-v6](https://www.cloudflare.com/ips-v6), [Cloudflare IP addresses](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/)
- Cloudflare: [Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/), [Global AOP](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/global/), [Zone-level AOP](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/zone-level/)
- Cloudflare: [WebSockets](https://developers.cloudflare.com/network/websockets/), [Network ports](https://developers.cloudflare.com/fundamentals/reference/network-ports/)
- nginx: [ngx_http_realip_module](https://nginx.org/en/docs/http/ngx_http_realip_module.html), [ngx_http_ssl_module](https://nginx.org/en/docs/http/ngx_http_ssl_module.html), [WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- nftables: [man nft](https://www.netfilter.org/projects/nftables/manpage.html), [Sets](https://wiki.nftables.org/wiki-nftables/index.php/Sets), [Atomic rule replacement](https://wiki.nftables.org/wiki-nftables/index.php/Atomic_rule_replacement)
