---
title: "Remnawave с нуля: панель в Docker за reverse proxy"
lede: "Установка панели по официальной инструкции: compose, секреты в .env, Caddy или nginx перед ней, первый вход и что бэкапить. Плюс грабли, на которые сообщество уже наступило."
category: panels
weight: 1
actual: "Remnawave 3.4.4 (по официальному репозиторию на 2026-09-24)"
lastmod: 2026-09-24
---

Официальная установка Remnawave занимает три команды и один конфиг прокси. Большая часть проблем в чатах начинается с попытки сэкономить на последнем: открыть порт 3000 наружу «на пять минут» или поставить скрипт, который делает всё сразу и непонятно как.

> [!NOTE]
> Гайд опирается на Remnawave **3.4.4** (релиз backend и panel от 2026-09-12) и на файлы `docker-compose-prod.yml` и `.env.sample` из ветки `main` репозитория [remnawave/backend](https://github.com/remnawave/backend) на 2026-09-24. Переменные окружения между версиями меняются: при 3.0 сообщество, например, ловило переименование секрета JWT в `APP_SECRET` ([Env](/baza/paneli/env/)). Перед установкой и каждым обновлением сверяйся с актуальным `.env.sample`.

## Что понадобится

Требования из документации:

| | Минимум | Рекомендуется |
|---|---|---|
| CPU | 2 ядра | 4 ядра |
| RAM | 2 ГБ | 4 ГБ |
| Диск | 20 ГБ | 20 ГБ |
| ОС | Ubuntu или Debian | |

Нужен Docker с плагином Compose. Документация ставит его официальным скриптом:

```bash
sudo curl -fsSL https://get.docker.com | sh
```

И обязательно **свой домен**, направленный A/AAAA-записью на сервер. Без домена официально только TryCloudflare, и то для разработки.

Панель не содержит Xray: трафик пользователей обслуживают ноды на отдельных серверах, их подключение описано в гайде [Нода Remnawave](/gaidy/noda-remnawave/).

> [!TIP]
> Опыт сообщества (июль 2026): панель в РФ держать не советуют, а сам сайт docs.rw из РФ без VPN может не открываться ([Ошибки → фиксы](/baza/paneli/oshibki-fiksy/), [Установка и обновление](/baza/paneli/ustanovka-obnovlenie/)). Документацию лучше открыть заранее.

{{< flow caption="Путь запроса к панели по официальной схеме: прокси в той же docker-сети `remnawave-network`, панель опубликована только на loopback" >}}
Браузер
!Caddy / nginx | HTTPS :443
Панель `remnawave` | HTTP :3000
Нода | mTLS
{{< /flow >}}

## Установка

### Файлы

```bash
mkdir /opt/remnawave && cd /opt/remnawave
curl -o docker-compose.yml https://raw.githubusercontent.com/remnawave/backend/refs/heads/main/docker-compose-prod.yml
curl -o .env https://raw.githubusercontent.com/remnawave/backend/refs/heads/main/.env.sample
```

Путь `/opt/remnawave` не обязателен, но на него ссылаются все остальные страницы документации, включая обновление.

### Секреты

`APP_SECRET`, `METRICS_PASS` и `WEBHOOK_SECRET_HEADER` в примере заданы значениями по умолчанию (`change_me`, `admin` и публичная строка из репозитория). Документация генерирует их так:

```bash
sed -i "s/^APP_SECRET=.*/APP_SECRET=$(openssl rand -hex 64)/" .env
sed -i "s/^METRICS_PASS=.*/METRICS_PASS=$(openssl rand -hex 64)/" .env
sed -i "s/^WEBHOOK_SECRET_HEADER=.*/WEBHOOK_SECRET_HEADER=$(openssl rand -hex 64)/" .env
```

Пароль Postgres по умолчанию `postgres`, его настоятельно советуют сменить. Команда из доки меняет его сразу в двух местах, `POSTGRES_PASSWORD` и `DATABASE_URL`:

```bash
pw=$(openssl rand -hex 24) && sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pw/" .env && sed -i "s|^\(DATABASE_URL=\"postgresql://postgres:\)[^\@]*\(@.*\)|\1$pw\2|" .env
```

> [!WARNING]
> Меняй пароль Postgres до первого `docker compose up`. Образ `postgres` берёт `POSTGRES_PASSWORD` только при инициализации пустого тома. Если база уже создана, новая строка в `.env` не сменит пароль внутри базы, и панель перестанет к ней подключаться.

### Домены

В `.env` правишь вручную:

```bash {name=".env"}
FRONT_END_DOMAIN=panel.example.com
SUB_PUBLIC_DOMAIN=panel.example.com/api/sub
PANEL_DOMAIN=panel.example.com
```

| Переменная | Обязательна | Зачем |
|---|---|---|
| `APP_SECRET` | да | секрет приложения, дока рекомендует от 64 символов |
| `FRONT_END_DOMAIN` | да | домен панели, из него строятся CORS-заголовки |
| `SUB_PUBLIC_DOMAIN` | да | домен и путь публичной ссылки подписки, без `http(s)://` и без `/` в конце |
| `PANEL_DOMAIN` | нет | прямые ссылки на панель, например в Telegram-уведомлениях |
| `DATABASE_URL` | да | строка подключения к Postgres в формате `postgresql://user:password@host:port/db` |

Пока отдельной страницы подписки нет, `SUB_PUBLIC_DOMAIN` равен домену панели плюс `/api/sub`. Остальные переменные (уведомления, вебхуки, метрики) описаны на странице [Environment Variables](https://docs.rw/install/environment-variables).

## Что внутри compose

Официальный `docker-compose.yml` поднимает три контейнера в сети `remnawave-network`:

| Контейнер | Образ | Порт на хосте |
|---|---|---|
| `remnawave` | `remnawave/backend:3` | `127.0.0.1:3000` (панель), `127.0.0.1:3001` (метрики) |
| `remnawave-db` | `postgres:18.4` | `127.0.0.1:6767` |
| `remnawave-redis` | `valkey/valkey:9-alpine` | нет, только unix-сокет |

Что из этого следует:

- Все порты уже опубликованы на `127.0.0.1`. Не «исправляй» это на `3000:3000`.
- Тег `remnawave/backend:3` держит мажорную версию: `docker compose pull` обновит до последней 3.x, но не перепрыгнет на 4.
- Valkey запущен с `--save ""` и `--appendonly no`, то есть ничего не пишет на диск. Всё, что нужно сохранить, лежит в Postgres.
- У всех сервисов ограничены логи (`json-file`, 100 МБ × 5 файлов).

## Запуск

```bash
cd /opt/remnawave && docker compose up -d && docker compose logs -f -t
```

> [!IMPORTANT]
> `.env` читается при создании контейнера. Документация прямо пишет: после правки переменных нужен `docker compose down && docker compose up -d`, простой `restart` старое окружение не заменит. В сообществе это одна из самых частых причин «поменял, а не работает» ([Установка и обновление](/baza/paneli/ustanovka-obnovlenie/)).

## Reverse proxy

Документация выделяет это красным: прокси обязателен, наружу сервисы не выставлять, только `127.0.0.1`. Дополнительные требования:

- Панель работает только на корне домена или поддомена. Путь вида `example.com/remnawave` не поддерживается.
- SSH-проброс порта (`ssh -L 3000:...`) тоже не поддерживается.

Причина в коде backend: middleware разрывает соединение, если в запросе нет заголовка `X-Forwarded-For` или `X-Forwarded-Proto` не равен `https`, и пишет в лог `Reverse proxy and HTTPS are required.` Поэтому `curl http://127.0.0.1:3000` получит обрыв соединения вместо ответа, и это нормально.

### Caddy (официальный вариант)

Caddy сам получает сертификат и сам проставляет `X-Forwarded-For` и `X-Forwarded-Proto`.

```caddy {name="/opt/remnawave/caddy/Caddyfile"}
https://panel.example.com {
        encode
        reverse_proxy * http://remnawave:3000
}
:443 {
    tls internal
    respond 204
}
```

Второй блок ловит всё остальное на 443: запросы с чужим именем или по голому IP получают самоподписанный сертификат и пустой ответ 204, а не панель.

```yaml {name="/opt/remnawave/caddy/docker-compose.yml"}
services:
  caddy:
    image: caddy:2.9
    container_name: 'caddy'
    hostname: caddy
    restart: always
    ports:
      - '0.0.0.0:443:443'
      - '0.0.0.0:80:80'
    networks:
      - remnawave-network
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-ssl-data:/data

networks:
  remnawave-network:
    name: remnawave-network
    driver: bridge
    external: true

volumes:
  caddy-ssl-data:
    driver: local
    external: false
    name: caddy-ssl-data
```

```bash
cd /opt/remnawave/caddy && docker compose up -d && docker compose logs -f -t
```

Caddy подключается к внешней сети `remnawave-network` и ходит к панели по имени контейнера. Поэтому панель сначала, прокси потом: сеть создаёт compose панели.

### nginx

Официальный гайд по nginx устроен так же (контейнер `remnawave-nginx` в сети `remnawave-network`, `proxy_pass http://remnawave:3000`), но сертификат выпускается отдельно через acme.sh в режиме TLS-ALPN на порту 8443. Две детали оттуда: порт 8443 должен быть свободен и открыт при каждом продлении, а зоны `.ru`, `.su` и `.рф` этот способ не поддерживает, потому что их не обслуживает ZeroSSL. В конфиге обязательны `proxy_set_header X-Forwarded-For` и `X-Forwarded-Proto $scheme`, иначе сработает проверка выше. Про сертификаты подробнее в гайде [TLS-сертификаты](/gaidy/tls-sertifikaty/).

{{< compare bad="Панель наружу" good="Панель за прокси" >}}
```yaml
ports:
  - 3000:3000
```
Порт открыт миру в обход файрвола, а панель всё равно разорвёт соединение без HTTPS-прокси.
---
```yaml
ports:
  - 127.0.0.1:3000:${APP_PORT:-3000}
```
Как в официальном compose. Снаружи только 443 у Caddy или nginx.
{{< /compare >}}

> [!NOTE]
> Документация советует проксировать домен через Cloudflare (оранжевое облако), если Cloudflare нормально работает в твоём регионе. Для аудитории из РФ это «если» важное, разбор в гайдах [nginx за Cloudflare](/gaidy/nginx-za-cloudflare/) и [Сайт не открывается из РФ](/gaidy/sayt-ne-otkryvaetsya-iz-rf/).

## Первый вход

Открываешь `https://panel.example.com`, видишь форму регистрации. **Первый зарегистрированный пользователь становится суперадмином.** Поэтому регистрируйся сразу, как только прокси заработал, а не оставляй свежую панель висеть в интернете.

Забыл пароль или случайно отключил вход по паролю через OAuth-настройки: поможет Rescue CLI.

```bash
docker exec -it remnawave cli
```

В меню есть сброс суперадмина (после него панель снова предложит создать аккаунт) и включение входа по паролю.

## Данные и бэкапы

| Что | Где |
|---|---|
| База панели | docker-том `remnawave-db-data` |
| Секреты и настройки | `/opt/remnawave/.env`, `/opt/remnawave/docker-compose.yml` |
| Прокси | `Caddyfile` и том `caddy-ssl-data` (или конфиг nginx и сертификаты) |

В базе, кроме пользователей и настроек, лежит таблица `keygen`: корневой сертификат, которым панель подписывает ключи нод. Потеряешь базу без дампа, и каждой ноде придётся выдавать новый `SECRET_KEY`. Восстановишь из дампа, и ноды подключатся со старыми ключами.

Бэкапить логическим дампом `pg_dump`, а не копией тома. Скрипт, шифрованный репозиторий и проверка восстановления в гайде [Бэкапы: pg_dump, restic и systemd](/gaidy/bekapy-restic/), опыт сообщества в [Бэкапах](/baza/set/bekapy/).

## Безопасность

- Проверь, что наружу смотрят только 80/443 прокси: `ss -tlnp`. Почему `ufw` и nftables не видят опубликованные Docker-порты, разобрано в гайде [Docker для панелей и ботов](/gaidy/docker-dlya-paneley/).
- Файрвол хоста по гайду [nftables: минимальный файрвол](/gaidy/nftables-minimalnyy-fayrvol/). Для связи с нодами на панели ничего открывать не нужно: соединение инициирует панель.
- Дополнительная защита страницы входа из официального раздела [Panel Security](https://docs.rw/install/panel-security/): Caddy с авторизацией и секретным путём (`remnawave/caddy-with-auth`), TinyAuth для nginx, Cloudflare Zero Trust.

## Обновление

```bash
cd /opt/remnawave && docker compose pull && docker compose down && docker compose up -d && docker compose logs -f
docker image prune
```

Порядок из документации: сначала панель, потом ноды. Перед обновлением дамп базы и чтение changelog. Подробно в гайде [Обновления без поломок](/gaidy/obnovleniya-bez-polomok/).

## Типовые ошибки

| Симптом | Причина и что делать |
|---|---|
| Соединение рвётся, в логе `Reverse proxy and HTTPS are required.` | Запрос пришёл мимо прокси или прокси не передал `X-Forwarded-For` / `X-Forwarded-Proto: https`. Проверь заголовки в конфиге nginx. |
| Поменял `.env`, ничего не изменилось | Нужен `docker compose down && docker compose up -d`, не `restart`. |
| Панель не подключается к базе после смены пароля | Пароль сменили в `.env` уже после инициализации тома, а образ `postgres` применяет его только к пустому каталогу данных. Меняй пароль внутри базы или делай это до первого запуска. |
| В nginx `host not found in upstream` | Прокси не в сети `remnawave-network`. В сообществе классика ([Реверс-прокси](/baza/set/reverse-proxy/)). |
| Прокси не стартует, 443 занят | В сообществе фиксировали: nginx и Caddy на одном сервере вместе не живут, оставь один ([Реверс-прокси](/baza/set/reverse-proxy/)). |
| После обновления сломались бот или ноды | Сообщество регулярно ловит несовместимость версий: при 3.0 бот Bedolaga падал с `KeyError: 'uuid'`, ноды не стыковались с панелью другой версии ([Ошибки → фиксы](/baza/paneli/oshibki-fiksy/), [Релизы](/baza/paneli/relizy/)). Бот и панель обновляй согласованно, см. [Бот Bedolaga](/gaidy/bedolaga-bot/). |

Больше случаев с датами в [индексе ошибок](/baza/indeksy/oshibki/).

## Источники

- Remnawave: [Requirements](https://docs.rw/install/requirements), [Remnawave Panel](https://docs.rw/install/remnawave-panel), [Environment Variables](https://docs.rw/install/environment-variables), [Upgrading](https://docs.rw/install/upgrading)
- Remnawave: [Reverse Proxies](https://docs.rw/install/reverse-proxies/), [Caddy](https://docs.rw/install/reverse-proxies/caddy), [Nginx](https://docs.rw/install/reverse-proxies/nginx), [Panel Security](https://docs.rw/install/panel-security/)
- Remnawave: [Initial Setup](https://docs.rw/learn-en/quick-start), [Rescue CLI](https://docs.rw/features/rescue-cli), исходники документации в [remnawave/panel](https://github.com/remnawave/panel/tree/main/docs)
- remnawave/backend 3.4.4: [docker-compose-prod.yml](https://github.com/remnawave/backend/blob/main/docker-compose-prod.yml), [.env.sample](https://github.com/remnawave/backend/blob/main/.env.sample), [proxy-check.middleware.ts](https://github.com/remnawave/backend/blob/main/src/common/middlewares/proxy-check.middleware.ts), [cli.ts](https://github.com/remnawave/backend/blob/main/src/bin/cli/cli.ts), [релизы](https://github.com/remnawave/backend/releases)
- Caddy: [reverse_proxy, заголовки по умолчанию](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults)
- Опыт сообщества: [Установка и обновление](/baza/paneli/ustanovka-obnovlenie/), [Docker-compose](/baza/paneli/docker-compose/), [Env](/baza/paneli/env/), [Nginx / Caddy](/baza/paneli/reverse-proxy/), [Ошибки → фиксы](/baza/paneli/oshibki-fiksy/), [Релизы](/baza/paneli/relizy/), [Реверс-прокси](/baza/set/reverse-proxy/), [Индекс ошибок](/baza/indeksy/oshibki/)
