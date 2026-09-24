---
title: "TLS-сертификаты без боли: Caddy, certbot, acme.sh"
lede: "Три способа получить сертификат Let's Encrypt и не вспоминать о нём, пока он сам продлевается. Плюс как проверить, что продление действительно работает."
category: web
weight: 1
actual: "Caddy 2.x, certbot 4.x, acme.sh 3.x, OpenSSL 3.x"
lastmod: 2026-09-23
---

Сертификат выпускается за минуту, а истекает всегда в пятницу вечером. Вся работа здесь не в выпуске, а в том, чтобы продление шло само, сервис подхватывал новый файл, и ты узнавал о проблеме раньше клиентов.

## Какой инструмент выбрать

- **Caddy**, если он и так твой реверс-прокси. Сертификаты выпускает и продлевает сам, настраивать нечего.
- **certbot**, если стоит nginx и нужен сертификат на пару доменов.
- **acme.sh**, если нужен wildcard, порты 80/443 заняты (Xray, selfsteal) или сертификат нужен файлами для Xray и ноды.

Одно правило для всех: один домен обслуживает один ACME-клиент. В сообществе был случай, когда выпуск сертификата для кабинета через второй инструмент уронил панель в 500 ([база](/baza/set/sertifikaty/)).

## Caddy: автоматический HTTPS

Caddy выпускает сертификат для каждого домена, который встречает в конфиге, продлевает его и сам редиректит HTTP на HTTPS. Условия из документации:

- A/AAAA-записи домена указывают на сервер;
- порты 80 и 443 открыты снаружи, и Caddy может их слушать;
- каталог данных Caddy доступен на запись и **не теряется** между перезапусками;
- домен указан в конфиге.

```caddyfile {name="/etc/caddy/Caddyfile"}
{
	email admin@example.com
}

panel.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

```bash
systemctl reload caddy
journalctl -u caddy --no-pager | less +G
```

При установке из пакета Caddy работает от пользователя `caddy`, а сертификаты лежат в `/var/lib/caddy/.local/share/caddy`. В Docker это том `/data`.

> [!WARNING]
> Контейнер Caddy без именованного тома на `/data` при каждом пересоздании выпускает сертификаты заново. Документация Caddy отдельно предупреждает: каталог данных не кеш. Частые `docker compose up --force-recreate` без тома быстро упираются в лимиты Let's Encrypt (см. ниже).

Если Let's Encrypt не выдал сертификат, Caddy по умолчанию попробует ZeroSSL. Поэтому письмо от Let's Encrypt «сертификат скоро истечёт» может быть ложной тревогой: смотри издателя в самом сертификате.

Wildcard в Caddy требует DNS-01, а для него нужна сборка Caddy с модулем своего DNS-провайдера из репозиториев `caddy-dns`. Для Cloudflare:

```caddyfile {name="/etc/caddy/Caddyfile"}
*.example.com {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:8080
}
```

Типовая грабля: Caddy не может выпустить сертификат, потому что домен не резолвится (NXDOMAIN) или бесплатный DNS-сервис не даёт выпустить сертификат на свой поддомен. Разборы в [ошибках панелей](/baza/paneli/oshibki-fiksy/). Примеры Caddyfile для панели, кабинета и вебхуков: [Nginx / Caddy](/baza/paneli/reverse-proxy/).

## certbot + nginx

Плагин nginx сам выпускает сертификат и прописывает его в конфиг:

```bash
certbot --nginx -d panel.example.com
```

Если не хочешь, чтобы certbot трогал конфиги, используй webroot: certbot кладёт файл проверки в `<webroot>/.well-known/acme-challenge/`, а nginx должен его отдать по HTTP на порту 80.

```nginx {name="/etc/nginx/conf.d/acme.conf"}
server {
    listen 80;
    server_name panel.example.com;
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}
```

```bash
certbot certonly --webroot -w /var/www/letsencrypt -d panel.example.com \
  --deploy-hook "systemctl reload nginx"
```

Файлы появятся в `/etc/letsencrypt/live/panel.example.com/`: `fullchain.pem` и `privkey.pem`. Указывай на них напрямую, не копируй: при продлении certbot обновляет именно эти пути.

### Продление и deploy-hook

Большинство способов установки certbot сами ставят таймер или cron на `certbot renew`. Проверь:

```bash
systemctl list-timers | grep -i certbot
grep -r certbot /etc/crontab /etc/cron.d/ 2>/dev/null
```

`certbot renew` продлевает только то, что пора продлевать (с certbot 4.0, когда осталось меньше трети срока), поэтому запускать его можно хоть дважды в день. Недельный cron для этого слишком редкий, на что в сообществе уже наступали ([база](/baza/set/sertifikaty/)).

`--deploy-hook` выполняется только после **успешного** выпуска и сохраняется для следующих продлений. Для хука на все сертификаты сразу положи исполняемый файл в каталог:

```bash {name="/etc/letsencrypt/renewal-hooks/deploy/reload.sh"}
#!/bin/sh
# $RENEWED_LINEAGE: например /etc/letsencrypt/live/panel.example.com
systemctl reload nginx
# если сервис в контейнере не перечитывает сертификат сам, перезапусти его
# docker restart remnanode
```

```bash
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload.sh
certbot renew --dry-run
```

> [!NOTE]
> `--dry-run` ходит в staging Let's Encrypt, у которого лимиты заметно выше, и боевые лимиты не трогает. Deploy-хуки при этом **не запускаются**, если не добавить `--run-deploy-hooks`. Проверь их отдельно: `certbot renew --dry-run --run-deploy-hooks`.

Список сертификатов и сроки: `certbot certificates`.

## acme.sh: wildcard через Cloudflare DNS

DNS-01 не нужны открытые порты: подтверждение идёт TXT-записью. Это единственный способ получить wildcard у Let's Encrypt.

```bash
curl https://get.acme.sh | sh -s email=admin@example.com
# после установки перезайди в shell, чтобы появился alias acme.sh
acme.sh --set-default-ca --server letsencrypt
```

> [!IMPORTANT]
> С версии 3.0 CA по умолчанию у acme.sh не Let's Encrypt, а ZeroSSL. Если нужен Let's Encrypt, выполни `--set-default-ca` до первого выпуска.

Токен создай в Cloudflare (Profile → API Tokens) с правом **Zone → DNS → Edit** только на нужную зону. Global API Key не используй: его утечка отдаёт весь аккаунт.

```bash
export CF_Token="токен"
export CF_Zone_ID="id-зоны"        # для одной зоны
# или CF_Account_ID="id-аккаунта"  # если зон несколько в одном аккаунте

acme.sh --issue --dns dns_cf -d example.com -d '*.example.com'
```

Zone ID и Account ID видны на странице Overview зоны справа, в блоке API. Переменные acme.sh сохранит в `~/.acme.sh/account.conf` и переиспользует при продлении, заново экспортировать не придётся.

В примере из wiki указаны оба имени, и сам домен, и wildcard: нужен сертификат на оба, перечисляй оба.

### --install-cert и reloadcmd

Файлы из `~/.acme.sh/` использовать напрямую нельзя: README говорит, что это внутренняя структура и она может измениться. Копируем туда, откуда их читает сервис:

```bash
acme.sh --install-cert -d example.com \
  --key-file       /etc/ssl/example.com/privkey.pem \
  --fullchain-file /etc/ssl/example.com/fullchain.pem \
  --reloadcmd      "systemctl reload nginx"
```

Параметры запоминаются: при каждом продлении acme.sh скопирует файлы заново и выполнит `--reloadcmd`. Без `reloadcmd` новый сертификат ляжет на диск, а сервис продолжит отдавать старый до истечения.

Установщик acme.sh ставит ежедневный cron. Проверить и посмотреть дату следующего продления:

```bash
crontab -l | grep acme
acme.sh --info -d example.com | grep Le_NextRenewTimeStr
```

> [!TIP]
> Один wildcard на все ноды удобен при selfsteal и DNS-балансировке, а раскатывать его по нодам можно через `--reloadcmd` со скриптом копирования. Подробнее о практике в [базе](/baza/set/sertifikaty/). Помни, что ключ от wildcard на каждой ноде увеличивает цену утечки, а CF_Token на ноде даёт право менять DNS.

## Проверка срока и цепочки

Что отдаёт сервер на самом деле, а не что лежит на диске:

```bash
echo | openssl s_client -connect panel.example.com:443 -servername panel.example.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

`-servername` задаёт SNI. Без него OpenSSL берёт имя из `-connect`, а при подключении по IP SNI не будет, и сервер может отдать не тот сертификат. Цепочка, которую отдаёт сервер, и её проверка:

```bash
# что именно прислал сервер, по порядку
echo | openssl s_client -connect panel.example.com:443 -servername panel.example.com -showcerts

# проверка цепочки: с -verify_return_error рукопожатие оборвётся на ошибке
echo | openssl s_client -connect panel.example.com:443 -servername panel.example.com \
  -verify_return_error -brief
```

Если в конфиге nginx указан `cert.pem` вместо `fullchain.pem`, сервер не отдаёт промежуточный сертификат. Документация certbot: для `ssl_certificate` в nginx нужен именно `fullchain.pem`, иначе часть браузеров покажет недоверенное соединение.

Для мониторинга подходит `-checkend`: код возврата не ноль, если сертификат истечёт в ближайшие N секунд.

```bash
echo | openssl s_client -connect panel.example.com:443 -servername panel.example.com 2>/dev/null \
  | openssl x509 -noout -checkend 1209600 || echo "меньше 14 дней"
```

acme.sh сам не пишет о скором истечении, так что такую проверку с алертом в Telegram стоит завести отдельно ([база](/baza/set/sertifikaty/)).

## Лимиты Let's Encrypt

Актуальные цифры с letsencrypt.org на момент написания:

| Лимит | Значение |
|---|---|
| Сертификатов на зарегистрированный домен | 50 за 7 дней |
| Сертификатов на один и тот же набор имён | 5 за 7 дней |
| Неудачных проверок на имя с одного аккаунта | 5 в час |
| Новых заказов на аккаунт | 300 за 3 часа |

Лимиты работают как ведро с токенами и восстанавливаются постепенно, сбросить их вручную нельзя. Продления через ARI (acme.sh использует его автоматически) от лимитов освобождены полностью. Обычное продление с тем же набором имён освобождено от лимитов на домен и на аккаунт, но не от лимита «5 на тот же набор». Для экспериментов используй staging: `--dry-run` у certbot, `--server letsencrypt_test` у acme.sh.

> [!CAUTION]
> Не завязывайся на «сертификат живёт 90 дней». Let's Encrypt сокращает срок: с 13 мая 2026 профиль `tlsserver` выдаёт 45-дневные сертификаты, с 10 февраля 2027 классический профиль перейдёт на 64 дня, с 16 февраля 2028 на 45. Самописный cron «раз в 60 дней» скоро перестанет успевать. Пусть продлением управляет клиент.

## Где смотреть выпущенные сертификаты

Каждый публичный сертификат попадает в логи Certificate Transparency. Поиск по ним: [crt.sh](https://crt.sh/) и Censys. Так видно, не выпускал ли кто-то сертификат на твой домен и какие поддомены уже «засвечены»: wildcard их не прячет, поддомены всё равно видны в SNI.

В досье домена на host.pink, например [host.pink/example.com](https://host.pink/example.com), есть карточка «Сертификаты и поддомены» с тем же из CT-логов.

## Источники

- [Caddy: Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Caddy: tls directive](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Caddy: Conventions (data directory)](https://caddyserver.com/docs/conventions)
- [Caddy: Install](https://caddyserver.com/docs/install)
- [Docker Official Image: caddy](https://hub.docker.com/_/caddy)
- [Certbot User Guide](https://eff-certbot.readthedocs.io/en/stable/using.html)
- [acme.sh README](https://github.com/acmesh-official/acme.sh)
- [acme.sh wiki: dnsapi (Cloudflare)](https://github.com/acmesh-official/acme.sh/wiki/dnsapi#dns_cf)
- [acme.sh wiki: Server](https://github.com/acmesh-official/acme.sh/wiki/Server), [Change default CA to ZeroSSL](https://github.com/acmesh-official/acme.sh/wiki/Change-default-CA-to-ZeroSSL)
- [Let's Encrypt: Rate Limits](https://letsencrypt.org/docs/rate-limits/)
- [Let's Encrypt: Challenge Types](https://letsencrypt.org/docs/challenge-types/)
- [Let's Encrypt: FAQ](https://letsencrypt.org/docs/faq/)
- [Let's Encrypt: Decreasing Certificate Lifetimes to 45 Days](https://letsencrypt.org/2025/12/02/from-90-to-45/)
- [OpenSSL: openssl-s_client](https://docs.openssl.org/3.0/man1/openssl-s_client/)
- [OpenSSL: openssl-x509](https://docs.openssl.org/3.0/man1/openssl-x509/)
