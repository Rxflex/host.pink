---
title: "Bedolaga-бот: установка и связка с Remnawave"
lede: "Бот продаёт подписки, панель их выдаёт, ноды возят трафик. Разбираем, как собрать эту цепочку по официальной инструкции и не наступить на грабли, которые сообщество уже собрало за тебя."
category: panels
weight: 6
actual: "Bedolaga 4.15, Remnawave 3.4 (по официальным репозиториям на 2026-09-24)"
lastmod: 2026-09-24
---

Установка Bedolaga занимает четыре команды из README. Остальное время уходит на то, чтобы понять, почему бот не видит панель, платёжка не может достучаться до вебхука, а после `git pull` всё упало. Ниже порядок, при котором этих вопросов меньше.

## Что это и из чего состоит

Bedolaga ([BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot)) принимает оплату и управляет подписками через API панели Remnawave. На ноды бот не ходит: он создаёт, продлевает и отключает пользователей в панели, а панель уже раздаёт конфиги нодам. Без развёрнутой панели бот бесполезен, это прямо указано в требованиях документации.

{{< flow caption="Цепочка запросов: бот работает только с API панели, нодами управляет Remnawave" >}}
Пользователь в Telegram
!Bedolaga-бот | webhook/polling
API Remnawave | Bearer-токен
Ноды | `NODE_PORT`
{{< /flow >}}

Официальный `docker-compose.yml` (ветка `main` на 2026-09-24) поднимает три сервиса:

| Сервис | Контейнер | Образ | Зачем |
|---|---|---|---|
| `bot` | `remnawave_bot` | собирается из исходников (`build: .`) | aiogram + FastAPI на порту 8080: Telegram webhook, вебхуки платёжек, Web API для кабинета |
| `postgres` | `remnawave_bot_db` | `postgres:15-alpine` | основная база |
| `redis` | `remnawave_bot_redis` | `redis:7-alpine` | кэш, корзины, rate limiting |

Веб-кабинет ([bedolaga-cabinet](https://github.com/BEDOLAGA-DEV/bedolaga-cabinet), React) живёт в отдельном репозитории и в этот compose не входит.

> [!IMPORTANT]
> Бот v4.0.0 и новее работает только с Remnawave 3.0.0+: в панели 3.0 пользователи получили числовые id вместо UUID, и бот перешёл на них целиком. На панели 2.8.x новый бот не заработает, старый бот не заработает на панели 3.x. Подробнее про порядок обновлений в гайде [Обновления без поломок](/gaidy/obnovleniya-bez-polomok/).

## Установка

Нужны Docker 20.10+ с Compose v2 и уже работающая панель (если её нет, начни с [Remnawave с нуля](/gaidy/remnawave-s-nulya/)). Команды из README, плюс закрепление на релизном теге:

```bash
git clone https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot.git
cd remnawave-bedolaga-telegram-bot
git checkout v4.15.0          # релизный тег вместо живой ветки main
cp .env.example .env
```

Контейнер бота работает от пользователя с UID 1000 (так задано в `Dockerfile`), а каталоги `logs`, `data`, `locales`, `uploads` монтируются с хоста. Сообщество регулярно ловит `Permission denied` и `Locale directory is not writable`, и лечится это одинаково ([ошибки](/baza/paneli/oshibki-fiksy/), с 2025 года; [кейсы](/baza/paneli/keysy/), 03.04.2026):

```bash
mkdir -p logs data/backups locales uploads
sudo chown -R 1000:1000 logs data locales uploads
```

### Порт 8080 не должен смотреть в мир

В официальном compose порт опубликован как `'${WEB_API_PORT:-8080}:8080'`, то есть на всех интерфейсах. Docker при этом обходит ufw (подробно в гайде [Docker для панелей](/gaidy/docker-dlya-paneley/)). Чтобы не править `docker-compose.yml` и не ломать себе `git pull`, положи рядом override-файл. Compose подхватывает его автоматически, а `!override` заменяет список портов целиком, а не дописывает к нему:

```yaml {name="docker-compose.override.yml"}
services:
  bot:
    ports: !override
      - "127.0.0.1:8080:8080"
```

Проверь итог командой `docker compose config | grep -A3 ports`: в выводе должен остаться один порт на `127.0.0.1`.

Запуск:

```bash
docker compose up -d --build
docker compose logs -f bot
```

## Минимальный .env

Документация называет обязательными четыре переменные. Всё остальное в `.env.example` (почти 1400 строк) имеет значения по умолчанию, и большую часть настроек удобнее менять из админки бота. Сообщество советует держать `.env` коротким и не раскомментировать лишнее ([установка и обновление](/baza/paneli/ustanovka-obnovlenie/), май 2026).

```bash {name=".env"}
# Токен от @BotFather
BOT_TOKEN=1234567890:AA...                 # ← свой
# Telegram ID админов через запятую
ADMIN_IDS=123456789                        # ← свой

# Адрес панели без /api на конце
REMNAWAVE_API_URL=https://panel.example.com  # ← свой домен
# Токен из Remnawave Settings → API Tokens
REMNAWAVE_API_KEY=<токен_из_панели>          # ← свой
REMNAWAVE_AUTH_TYPE=api_key

# База: пароль по умолчанию из compose (secure_password_123) не оставляй
POSTGRES_PASSWORD=сгенерируй_openssl_rand_hex_24   # ← свой
```

`POSTGRES_PASSWORD` читают и контейнер базы, и бот. Образ `postgres` применяет его только при первой инициализации пустого тома, поэтому пароль нужно выбрать до первого `up`. Если сменить его позже только в `.env`, бот не сможет подключиться к базе: в самой базе остался старый пароль.

> [!WARNING]
> После правки `.env` нужен `docker compose up -d`, а не `docker compose restart`: по документации Docker `restart` не применяет изменения конфигурации, в том числе переменных окружения. В базе это одна из самых частых жалоб: «бот не настроен», хотя `.env` верный ([установка и обновление](/baza/paneli/ustanovka-obnovlenie/), июль 2026).

## Связь с панелью

Токен создаётся в панели: **Remnawave Settings → API Tokens**. Бот передаёт его в заголовке `Authorization: Bearer`. Для панелей за дополнительной защитой есть другие режимы `REMNAWAVE_AUTH_TYPE` (`basic_auth`, `caddy`), а для панелей, поставленных скриптом eGames, переменная `REMNAWAVE_SECRET_KEY` в формате `ключ:значение`.

Адрес зависит от того, где стоит бот:

- **Отдельный сервер.** `REMNAWAVE_API_URL=https://panel.example.com`, запросы идут через reverse proxy панели. По опыту сообщества, вариант с `/api` на конце даёт `API Error 404` ([env](/baza/paneli/env/), апрель–май 2026).
- **Тот же сервер.** Бот подключается к Docker-сети панели `remnawave-network`, а адрес становится `REMNAWAVE_API_URL=http://remnawave:3000`. Для этого в репозитории есть `docker-compose.local.yml` (запуск с `-f docker-compose.local.yml`). В документации сеть описана с `external: true`: тогда Compose её не создаёт, и панель должна быть поднята первой. Подробно про внешние сети в [гайде по Docker](/gaidy/docker-dlya-paneley/).

> [!TIP]
> Если перед API панели стоит прокси с лимитом запросов, массовая синхронизация бота упрётся в 429. В `.env.example` для этого есть `REMNAWAVE_API_REQUESTS_PER_MINUTE` (0 означает «без ограничения»).

### Вебхуки от панели

Без них бот узнаёт об изменениях в панели только при синхронизации. Секрет общий для обеих сторон. `openssl rand -hex 32` даёт ровно 64 символа `[0-9a-f]` и подходит под требования обеих сторон: бот просит минимум 32 символа, `.env.sample` панели требует ровно 64 из `a-z`, `A-Z`, `0-9`.

```bash {name=".env (бот)"}
REMNAWAVE_WEBHOOK_ENABLED=true
REMNAWAVE_WEBHOOK_PATH=/remnawave-webhook
REMNAWAVE_WEBHOOK_SECRET=<вывод openssl rand -hex 32>   # ← одинаковый в обоих файлах
```

```bash {name="/opt/remnawave/.env (панель)"}
WEBHOOK_ENABLED=true
WEBHOOK_URL=https://hooks.example.com/remnawave-webhook  # ← свой домен
WEBHOOK_SECRET_HEADER=<тот же секрет>
```

Проверка: `curl -s https://hooks.example.com/remnawave-webhook` должен вернуть `{"status": "ok", "service": "remnawave_webhook", "enabled": true}`. Ошибка `RemnaWave webhook: invalid signature` в логах бота означает, что секреты не совпали ([env и вебхуки](/baza/platezhki/env-vebhuki/), 21.08.2026).

## Вебхуки платёжек через reverse proxy

Все платёжки, Telegram webhook и Web API обслуживает один FastAPI-сервер на порту 8080. У каждой платёжки свой путь: `/yookassa-webhook`, `/platega-webhook`, `/cryptobot-webhook` и так далее. Снаружи нужен HTTPS-домен (в документации `hooks.domain.com`) и reverse proxy, который отдаёт эти пути на `127.0.0.1:8080` или на `remnawave_bot:8080`, если прокси в той же Docker-сети.

{{< flow caption="Путь колбэка об оплате. Официальные примеры Caddy и nginx есть в разделе «Docker развёртывание» документации Bedolaga" >}}
Платёжка
!Reverse proxy | HTTPS, POST
Бот | `127.0.0.1:8080`
{{< /flow >}}

```nginx {name="/etc/nginx/sites-enabled/hooks.conf (фрагмент)"}
location = /yookassa-webhook {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Три грабли из базы ([env и вебхуки](/baza/platezhki/env-vebhuki/), август 2026):

- Роут вебхука монтируется только при `*_ENABLED=true` в `.env`. Если включить платёжку только из админки, вебхук отдаёт 404, а платёж зависает.
- «В платёжке оплачено, в боте нет» обычно значит, что URL вебхука не прописан в личном кабинете платёжки.
- HTTP 405 на хук почти всегда виноват reverse proxy.

Для YooKassa бот проверяет IP отправителя. Если перед ботом стоит свой прокси, его сеть указывают в `YOOKASSA_TRUSTED_PROXY_NETWORKS`. Приватные сети и диапазоны Cloudflare бот доверяет сам. Если прокси идёт через Cloudflare или анти-DDoS, документация требует пропускать метод `POST` и заголовок `X-Telegram-Bot-Api-Secret-Token`. Для режима webhook в `.env` задаются `BOT_RUN_MODE=webhook`, `WEBHOOK_URL`, `WEBHOOK_SECRET_TOKEN` и `WEB_API_ENABLED=true`. Состояние видно на `/health/unified`.

## Бэкапы

У бота есть встроенные автобэкапы (`BACKUP_AUTO_ENABLED=true` по умолчанию, раз в 24 часа, хранится 7 копий в `/app/data/backups`) с отправкой в Telegram-чат и паролем архива `BACKUP_ARCHIVE_PASSWORD`. Только лежат они на том же сервере. Внешний дамп снимай отдельно, имя роли бери из окружения контейнера:

```bash
docker exec remnawave_bot_db sh -c \
  'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > bot_$(date +%F).dump
```

В документации пример с `-U postgres`, но в compose бота роль называется `remnawave_user`, отсюда частая ошибка `role "postgres" does not exist` ([кейсы](/baza/paneli/keysy/), апрель 2026). Шифрование, выгрузка в S3 и проверка восстановления разобраны в гайде [Бэкапы через restic](/gaidy/bekapy-restic/).

## Типовые ошибки из базы

| Симптом | Причина и что делать | Где в базе |
|---|---|---|
| `Error -3 connecting to redis:6379` | `REDIS_URL=redis://redis:6379/0`, бот и redis в одной сети | [ошибки](/baza/paneli/oshibki-fiksy/), конец 2025 |
| `Cannot connect to host remnawave:3000` | бот не в сети панели: подключить к `remnawave-network` через compose | [ошибки](/baza/paneli/oshibki-fiksy/), конец 2025 и июнь–июль 2026 |
| `Pool overlaps` при создании сети | подсеть `172.20.0.0/16` из compose занята, сменить subnet | [ошибки](/baza/paneli/oshibki-fiksy/), сентябрь 2025 |
| `Cannot GET /api/nodes/usage/realtime` | бот и панель из разных поколений API: в конце 2025 лечили обновлением панели, в марте 2026 после панели 2.7 обновлением бота | [ошибки](/baza/paneli/oshibki-fiksy/) |
| `ZodValidationException "Invalid uuid"` | бот 3.x на панели 3.0+, нужен бот 4+ и кабинет 1.65+ | [ошибки](/baza/paneli/oshibki-fiksy/), август 2026 |
| `Validation failed` на бот 4.0 + панель 2.8.1 | обратный случай, обновить панель до 3.x | [ошибки](/baza/paneli/oshibki-fiksy/), август 2026 |
| Залипли «технические работы» после обновления | удалить ключ `maintenance_status` в Redis | [ошибки](/baza/paneli/oshibki-fiksy/), август 2026 |

> [!NOTE]
> Всё из таблицы выше это опыт сообщества, а не документация. Версии и даты указаны по страницам базы, со временем советы устаревают. Первым делом смотри `docker compose logs -f bot` и `docker compose ps`: все три контейнера должны быть запущены, а не перезапускаться по кругу.

## Источники

- Bedolaga: [README](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/blob/main/README.md), [docker-compose.yml](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/blob/main/docker-compose.yml), [.env.example](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/blob/main/.env.example), [Dockerfile](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/blob/main/Dockerfile), [релиз v4.15.0](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/releases/tag/v4.15.0)
- Документация Bedolaga: [Требования](https://docs.bedolagam.ru/getting-started/requirements), [Переменные окружения](https://docs.bedolagam.ru/getting-started/environment), [Docker развёртывание](https://docs.bedolagam.ru/getting-started/docker-deployment), [Интеграция с Remnawave](https://docs.bedolagam.ru/integrations/remnawave), [Обслуживание](https://docs.bedolagam.ru/bot/maintenance), [Устранение неполадок](https://docs.bedolagam.ru/getting-started/troubleshooting)
- Remnawave: [.env.sample](https://github.com/remnawave/backend/blob/main/.env.sample), [Environment variables](https://docs.rw/install/environment-variables), [Subscription page: API token](https://docs.rw/install/subscription-page/bundled)
- Docker: [compose restart](https://docs.docker.com/reference/cli/docker/compose/restart/), [Merge и `!override`](https://docs.docker.com/reference/compose-file/merge/), [образ postgres](https://hub.docker.com/_/postgres)
- База host.pink: [Установка и обновление](/baza/paneli/ustanovka-obnovlenie/), [Env-переменные](/baza/paneli/env/), [Ошибки и фиксы](/baza/paneli/oshibki-fiksy/), [Кейсы](/baza/paneli/keysy/), [Env и вебхуки платёжек](/baza/platezhki/env-vebhuki/), [API](/baza/skripty/api/), [Индекс env](/baza/indeksy/env/), [Индекс ошибок](/baza/indeksy/oshibki/)
