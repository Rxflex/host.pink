---
title: "Обновления панели, нод и бота без поломок"
lede: "Команда pull занимает десять секунд, откат без бэкапа занимает вечер. Порядок обновления Remnawave, нод и Bedolaga, закреплённые теги, проверка и откат, собранные из документации и чужих ошибок."
category: panels
weight: 7
actual: "Bedolaga 4.15, Remnawave 3.4 (по официальным репозиториям на 2026-09-24)"
lastmod: 2026-09-24
---

Панель, ноды и бот выпускаются независимо, но общаются по API, которое время от времени меняют без обратной совместимости. Типичный сценарий из базы: обновили что-то одно, и в понедельник у половины клиентов «0 байт».

## Кто от кого зависит

Официально: документация Remnawave ([Upgrading](https://docs.rw/install/upgrading)) советует обновлять **сначала панель, потом ноды** и перед этим читать changelog. Документация Bedolaga ведёт таблицу совместимости с панелью: бот `v4.0.0` требует Remnawave 3.0.0 (числовые id вместо UUID, ломающее изменение), GeoCheck из `v4.1.0` требует панель и ноду 3.3.0+.

Что сообщество узнало на практике:

| Дата | Что случилось | Вывод | Где |
|---|---|---|---|
| 28.03.2026 | Панель 2.7.0 не работала с нодами ниже 2.7: «обновил панель, у меня ноды по 0; обновил ноды, всё заработало». После обновления ноды пришлось перезапускать | ноды обновлять сразу за панелью | [релизы](/baza/paneli/relizy/) |
| 31.03.2026 | В панели 2.7.x убрали эндпоинты, старый бот получил `404 Cannot GET /api/nodes/usage/realtime` | бот обновлять после панели | [индекс релизов](/baza/indeksy/relizy/) |
| 30.06–09.07.2026 | Бот 3.62.0 требует Remnawave 2.8.0, обратной совместимости нет | панель и бот обновлять парой | [индекс релизов](/baza/indeksy/relizy/) |
| август 2026 | Панель 3.0.0: бот 3.67 на ней падает с `ZodValidationException "Invalid uuid"`, нужны бот 4+ и кабинет 1.65+. Бот 4.0 на панели 2.8.1 даёт `Validation failed` | мажор панели = мажор бота | [ошибки](/baza/paneli/oshibki-fiksy/) |
| 19–21.08.2026 | Нода 3.3.0 работает только с панелью 3.3.0 и не заводится на 3.2.2 | нода не новее панели | [релизы](/baza/paneli/relizy/) |
| 20–23.08.2026 | Панель 2.8.0 + нода `latest`: `Client network socket disconnected before secure TLS connection was established`. Лечили закреплением ноды 3.1.1 или 3.2.2 в compose | никакого `latest` | [ошибки](/baza/paneli/oshibki-fiksy/) |

Отсюда порядок, который в базе повторяют с весны 2026: панель, затем ноды, затем бот, затем кабинет ([кейсы](/baza/paneli/keysy/)).

{{< flow caption="Порядок обновления. Панель первой по docs.rw, бот и кабинет последними, потому что они клиенты API панели" >}}
Бэкап баз и .env
Релиз-ноты | прочитать все
!Панель | новый тег
Проверка | логи, ноды
Ноды | по одной
Бот и кабинет | тег под панель
{{< /flow >}}

## Бэкап до, а не после

И панель, и бот мигрируют базу при старте. У Remnawave это `prisma migrate deploy` в `docker-entrypoint.sh`, у Bedolaga Alembic в `main.py` (пропускается только при `SKIP_MIGRATION=true`). Скачать новый образ и запустить его значит изменить схему. Например, в Remnawave 3.0.0 миграция удаляет UUID пользователей и переименовывает колонку id. Вернуть старый образ поверх такой базы не получится, откат возможен только из дампа.

```bash
# панель: роль и база из окружения контейнера
docker exec remnawave-db sh -c \
  'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > /root/panel_$(date +%F).dump
# бот
docker exec remnawave_bot_db sh -c \
  'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > /root/bot_$(date +%F).dump
# конфиги
cp /opt/remnawave/.env /opt/remnawave/docker-compose.yml /root/
```

Проверь, что дамп не пустой (`pg_restore -l файл | head`), и унеси его с сервера. Расписание, шифрование и проверка восстановления разобраны в гайде [Бэкапы через restic](/gaidy/bekapy-restic/).

## Релиз-ноты

Где читать:

- панель: [релизы remnawave/backend](https://github.com/remnawave/backend/releases), анонсы на [f.docs.rw](https://f.docs.rw/c/announces/14);
- нода: [релизы remnawave/node](https://github.com/remnawave/node/releases);
- бот: [релизы](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/releases) и `CHANGELOG.md`, таблица версий панели на [docs.bedolagam.ru](https://docs.bedolagam.ru/integrations/remnawave);
- опыт тех, кто обновился раньше: [релизы в базе](/baza/paneli/relizy/).

Искать нужно три вещи: слова breaking, переименованные переменные окружения и требования к версии соседнего компонента. Пример из перехода на бот 4.0.0: `TRAFFIC_EXCLUDED_USER_UUIDS` стала `TRAFFIC_EXCLUDED_USER_IDS`, и значения нужно заново взять из панели, автоматически они не конвертируются.

> [!WARNING]
> Прыгать через много версий бота рискованно. По базе, с версий ниже 3.15.1 сначала обновлялись до 3.15.1 (там переход на Alembic), потом до последней ([установка и обновление](/baza/paneli/ustanovka-obnovlenie/), март–апрель 2026). Прыжок 3.46.1 → 3.60.0 падал с `DuplicateTableError` ([индекс релизов](/baza/indeksy/relizy/), 08.06.2026).

## Закрепи версии

В официальном `docker-compose-prod.yml` панели стоит `remnawave/backend:3`, то есть «любая 3.x». Нода в примерах документации идёт с `latest`. Так следующий `pull` может принести версию, о которой ты не знал. Удобнее указать точный тег и менять его руками:

{{< compare bad="Приедет то, что сейчас в реестре" good="Приедет то, что ты выбрал" >}}
```yaml
image: remnawave/backend:3
# нода
image: remnawave/node:latest
```
---
```yaml
image: remnawave/backend:3.4.4
# нода
image: remnawave/node:3.4.1
```
{{< /compare >}}

Обратная сторона мажорного тега: `:2` никогда не подтянет 3.x. На этом спотыкались: в базе есть жалобы «ремна обновляется только до 2.8.1», а совет из того же обсуждения сменить версию с `2` на `3` ([релизы](/baza/paneli/relizy/), [установка и обновление](/baza/paneli/ustanovka-obnovlenie/), 21.08.2026). Переход на новый мажор всегда делается сменой тега.

У бота образа в compose нет, он собирается из исходников (`build: .`). `docker compose pull` для такого сервиса ничего не скачает, поэтому версию закрепляют git-тегом:

```bash
cd /opt/remnawave-bedolaga-telegram-bot   # ← свой путь
git fetch --tags
git checkout v4.15.0
docker compose up -d --build
```

> [!NOTE]
> Готовые образы бота есть на Docker Hub (`fr1ngg/remnawave-bedolaga-telegram-bot`), но на 2026-09-24 теги там вида `v4.15.0-877690a7` и `latest`, чистого `v4.15.0` нет. Для закрепления проще git-тег.

## Обновление по шагам

Панель. В документации между `pull` и `up` ещё стоит `docker compose down`. Без него `up -d` тоже пересоздаёт контейнеры, у которых поменялся образ, тома при этом сохраняются:

```bash
cd /opt/remnawave
sed -i -E 's#remnawave/backend:[A-Za-z0-9._-]+#remnawave/backend:3.4.4#' docker-compose.yml
docker compose pull
docker compose up -d
docker compose logs -f remnawave
```

Ноды: по одной, начиная с наименее нагруженной. На ноде нет базы, конфиги хранятся в панели, так что откат ноды сводится к смене тега.

```bash
cd /opt/remnanode
sed -i -E 's#remnawave/node:[A-Za-z0-9._-]+#remnawave/node:3.4.1#' docker-compose.yml
docker compose pull
docker compose up -d
docker compose logs -f
```

Бот и кабинет обновляются последними и вместе. В базе фиксировали связки кабинет 1.64 с ботом 3.67 и кабинет 1.65+ под Remnawave 3.0 ([релизы](/baza/paneli/relizy/)). Про устройство compose, сети и чистку старых образов есть отдельный гайд [Docker для панелей](/gaidy/docker-dlya-paneley/).

## Проверка после обновления

- `docker compose ps`: контейнер не перезапускается по кругу. У панели есть healthcheck, статус должен стать `healthy`.
- Логи панели: миграции прошли, ошибок нет. При неудачной миграции контейнер завершается сам, это заложено в entrypoint.
- В панели все ноды подключены. Нода, которая висит offline после обновления, это повод откатить именно её, а не всё сразу.
- Бот: `docker compose logs -f bot` без ошибок API, в админке проходит синхронизация с панелью, `/health/unified` отвечает.
- Одно реальное подключение клиентом и тестовая выдача подписки через бота.

## Откат

1. Вернуть прежний тег (или `git checkout` прежнего тега у бота).
2. Если новая версия успела стартовать, миграции уже применены. Остановить приложение и восстановить дамп:

```bash
cd /opt/remnawave
docker compose stop remnawave
docker exec -i remnawave-db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < /root/panel_ДАТА.dump
docker compose up -d
```

3. Кэш панели (valkey) в официальном compose работает без сохранения на диск (`--save ""`, `--appendonly no`) и пустеет при пересоздании контейнера. По опыту сообщества, если после восстановления панель не встаёт, помогает очистить redis ([бэкапы](/baza/set/bekapy/)). У бота похожий случай: залипший режим техработ лечится удалением ключа `maintenance_status` в Redis ([ошибки](/baza/paneli/oshibki-fiksy/), август 2026).

## Postgres между major-версиями

22.06.2026 в официальном compose панели образ базы сменился с `postgres:17.6` на `postgres:18.4`, и одновременно точка монтирования тома переехала с `/var/lib/postgresql/data` на `/var/lib/postgresql`. Причина во втором изменении: начиная с 18-й версии образ `postgres` хранит данные в `/var/lib/postgresql/18/docker`.

> [!CAUTION]
> Не копируй новый compose поверх рабочей установки на 17-м Postgres. Формат данных между major-версиями меняется, и PostgreSQL 18 не запустится на каталоге от 17-го. Официальные пути: дамп старой версией (`pg_dumpall`) и восстановление в новый пустой том либо `pg_upgrade`. Старый том не удаляй, пока не проверишь новый.

Опыт сообщества здесь скромный: скрипт distillium/remnawave-backup-restore с Postgres 18 сам не восстанавливал, приходилось вручную ([бэкапы](/baza/set/bekapy/), конец 2025). После того как в форке eGames подняли Postgres, нормального переноса с форка на обычную Remnawave не осталось ([релизы](/baza/paneli/relizy/), 20.07.2026). Бота это пока не касается: у него в compose `postgres:15-alpine`, этот тег обновляет только минорные версии 15.x.

Если ставишь с нуля, бери актуальный compose из документации, см. [Remnawave с нуля](/gaidy/remnawave-s-nulya/) и [Нода Remnawave](/gaidy/noda-remnawave/). Про связку бота с панелью есть гайд [Bedolaga-бот](/gaidy/bedolaga-bot/).

## Источники

- Remnawave: [Upgrading](https://docs.rw/install/upgrading), [Remnawave Panel](https://docs.rw/install/remnawave-panel), [Remnawave Node](https://docs.rw/install/remnawave-node), [docker-compose-prod.yml](https://github.com/remnawave/backend/blob/main/docker-compose-prod.yml) и [коммит с Postgres 18.4](https://github.com/remnawave/backend/commit/f3ff9a4070), [docker-entrypoint.sh](https://github.com/remnawave/backend/blob/main/docker-entrypoint.sh), релизы [backend 3.0.0](https://github.com/remnawave/backend/releases/tag/3.0.0), [backend 3.4.4](https://github.com/remnawave/backend/releases/tag/3.4.4), [node 3.4.1](https://github.com/remnawave/node/releases/tag/3.4.1)
- Bedolaga: [Интеграция с Remnawave](https://docs.bedolagam.ru/integrations/remnawave), [Устранение неполадок](https://docs.bedolagam.ru/getting-started/troubleshooting), [docker-compose.yml](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/blob/main/docker-compose.yml), [main.py](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/blob/main/main.py), [релиз v4.15.0](https://github.com/BEDOLAGA-DEV/remnawave-bedolaga-telegram-bot/releases/tag/v4.15.0), [Docker Hub](https://hub.docker.com/r/fr1ngg/remnawave-bedolaga-telegram-bot/tags)
- Docker: [compose up](https://docs.docker.com/reference/cli/docker/compose/up/), [compose pull](https://docs.docker.com/reference/cli/docker/compose/pull/), [образ postgres, PGDATA](https://hub.docker.com/_/postgres)
- PostgreSQL: [Upgrading a PostgreSQL Cluster](https://www.postgresql.org/docs/current/upgrading.html)
- База host.pink: [Установка и обновление](/baza/paneli/ustanovka-obnovlenie/), [Релизы](/baza/paneli/relizy/), [Кейсы](/baza/paneli/keysy/), [Ошибки и фиксы](/baza/paneli/oshibki-fiksy/), [Бэкапы](/baza/set/bekapy/), [Индекс релизов](/baza/indeksy/relizy/), [Индекс ошибок](/baza/indeksy/oshibki/)
