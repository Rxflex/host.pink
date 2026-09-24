---
title: "Бэкапы, которые восстанавливаются: pg_dump, restic и systemd"
lede: "Дамп базы панели, шифрованный репозиторий в S3, расписание и, главное, проверка восстановления. Бэкап, который ни разу не восстанавливали, это надежда, а не бэкап."
category: server
weight: 8
actual: "restic 0.17+, PostgreSQL 16–18 в Docker, systemd"
lastmod: 2026-09-23
---

Бэкапы делают все. Восстанавливают их обычно в три часа ночи, после того как хостер «потерял диск», и именно тогда выясняется, что дамп пустой, пароль от репозитория был только на умершем сервере, а Redis после восстановления надо сносить. Этот гайд про то, как узнать всё это заранее.

## Что бэкапить

Для панели и бота на PostgreSQL минимальный набор:

- **Логический дамп базы** (`pg_dump`). Не копия каталога `postgres_data`.
- **`.env` и `docker-compose.yml`**: без секретов из `.env` дамп не поднимется в новой инсталляции.
- **Конфиги реверс-прокси** и сертификаты, если выпускаешь их не через Caddy.

Сообщество обжигалось именно на мелочах: не та роль в `pg_dump`, забытый `.env` при переезде, готовый скрипт восстановления не справился с Postgres 18. Подборка случаев в базе: [Бэкапы и restore](/baza/set/bekapy/) и [Установка и обновление](/baza/paneli/ustanovka-obnovlenie/).

> [!NOTE]
> Почему дамп, а не копия тома. Документация PostgreSQL прямо говорит: для файловой копии сервер должен быть остановлен, «полумеры» вроде запрета подключений не работают. Плюс формат файлов данных может меняться между мажорными версиями, а `pg_dump` как раз штатный способ переноса на новую версию. В образах Postgres 18+ ещё и сменился путь `PGDATA`. Дамп от всего этого не зависит.

## Дамп из контейнера

`pg_dump` снимает согласованный снимок на работающей базе и не блокирует ни читателей, ни писателей. Формат `-Fc` (custom) сжат по умолчанию и читается `pg_restore`, умеющим восстанавливать выборочно и параллельно.

Имя пользователя не угадываем, а берём из окружения контейнера. Официальный образ `postgres` создаёт суперпользователя из `POSTGRES_USER`, а если `POSTGRES_DB` не задан, база называется так же, как пользователь:

```bash
docker exec remnawave-db sh -c \
  'pg_dump -Fc -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}"' \
  > /var/backups/panel/panel.dump
```

Одинарные кавычки важны: переменные должны раскрыться внутри контейнера, а не на хосте. Это заодно лечит частую ошибку `role "postgres" does not exist`, когда у бота роль называется иначе.

> [!TIP]
> Имя контейнера смотри в `docker ps`. У панели это обычно `remnawave-db`, у бота Bedolaga `remnawave_bot_db`. У бота к тому же есть встроенные автобэкапы (`BACKUP_AUTO_ENABLED` и соседние переменные в `.env`), см. [базу](/baza/set/bekapy/). Встроенный бэкап хорошо, но он лежит на том же сервере.

Быстро убедиться, что дамп читается, не восстанавливая его. `pg_restore -l` выводит оглавление архива, а без имени файла читает стандартный ввод:

```bash
docker exec -i remnawave-db pg_restore -l < /var/backups/panel/panel.dump | head
```

`pg_dump` не сохраняет роли и табличные пространства (для них есть `pg_dumpall`). Для панели в Docker это обычно не проблема: роль создаёт сам образ из `POSTGRES_USER`.

## restic: репозиторий в S3

restic шифрует и дедуплицирует, поэтому ежедневный дамп на сотни мегабайт не превращается в терабайты. Подойдёт любое S3-совместимое хранилище. Формат адреса для не-Amazon S3: `s3:https://server:port/bucket_name`.

Секреты в отдельный файл, доступный только root:

```ini {name="/etc/restic/env"}
RESTIC_REPOSITORY=s3:https://s3.example-provider.com/my-backups
RESTIC_PASSWORD_FILE=/etc/restic/password
AWS_ACCESS_KEY_ID=ключ
AWS_SECRET_ACCESS_KEY=секрет
# регион по умолчанию us-east-1; если провайдер требует свой:
# AWS_DEFAULT_REGION=ru-1
```

```bash
install -d -m 700 /etc/restic
openssl rand -base64 32 > /etc/restic/password
chmod 600 /etc/restic/env /etc/restic/password

set -a; . /etc/restic/env; set +a
restic init
```

> [!CAUTION]
> Документация restic: «Losing your password means that your data is irrecoverably lost». Пароль от репозитория сохрани **вне** сервера: в менеджер паролей, вместе с ключами от S3. Если он жил только в `/etc/restic/password` на сервере, который умер, бэкапов у тебя нет.

restic ожидает path-style адреса (`хост/бакет`), а не `бакет.хост`. Если провайдер умеет только virtual-hosted стиль, есть опция `-o s3.bucket-lookup=dns`.

## Скрипт бэкапа

```bash {name="/usr/local/sbin/backup-panel.sh"}
#!/usr/bin/env bash
set -euo pipefail

DUMP_DIR=/var/backups/panel
install -d -m 700 "$DUMP_DIR"

# 1. Дамп во временный файл, чтобы упавший pg_dump не затёр прошлый
docker exec remnawave-db sh -c \
  'pg_dump -Fc -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}"' \
  > "$DUMP_DIR/panel.dump.tmp"
mv "$DUMP_DIR/panel.dump.tmp" "$DUMP_DIR/panel.dump"

# 2. Дамп + конфиги в репозиторий
restic backup --tag panel "$DUMP_DIR" /opt/remnawave

# 3. Политика хранения и удаление лишних данных
restic forget --tag panel --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# 4. Проверка структуры репозитория и 5% данных
restic check --read-data-subset=5%
```

```bash
chmod 700 /usr/local/sbin/backup-panel.sh
```

Что здесь происходит:

- **`forget`** удаляет снимки по политике, **`prune`** удаляет данные, на которые больше никто не ссылается. `--prune` делает оба шага за раз. Политика применяется отдельно к каждой группе снимков, по умолчанию группировка по хосту и путям, так что снимки другого сервера в том же репозитории не пострадают.
- Во время `prune` репозиторий заблокирован и параллельный `backup` не пройдёт. Если в один репозиторий пишут несколько серверов, разнеси их по времени.
- **`check`** без флагов проверяет только структуру. `--read-data-subset=5%` дополнительно скачивает и проверяет случайные 5% данных. Полный `--read-data` читает всё и стоит трафика.
- `restic backup` возвращает код 3, если часть файлов не удалось прочитать. С `set -e` скрипт упадёт, и таймер покажет ошибку: так и задумано.

> [!TIP]
> Начиная с restic 0.17 можно не держать дамп на диске: `restic backup --stdin-filename panel.dump --stdin-from-command -- docker exec remnawave-db pg_dump ...`. restic проверяет код возврата команды и отменяет бэкап при ошибке, в отличие от `pg_dump | restic backup --stdin`, который провал не заметит. Но локальная копия дампа тоже полезна: это вторая копия из правила 3-2-1.

Если `/opt/remnawave` у тебя содержит bind-mount с файлами базы, исключи его через `--exclude`: живые файлы Postgres в бэкапе бесполезны.

## Расписание: systemd timer

```ini {name="/etc/systemd/system/backup-panel.service"}
[Unit]
Description=Backup panel DB and configs to restic
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
EnvironmentFile=/etc/restic/env
ExecStart=/usr/local/sbin/backup-panel.sh
```

```ini {name="/etc/systemd/system/backup-panel.timer"}
[Unit]
Description=Daily panel backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
```

- **`Persistent=true`** запоминает время последнего запуска на диске. Если сервер был выключен в момент срабатывания, сервис запустится сразу после включения таймера. Работает только с `OnCalendar=`.
- **`RandomizedDelaySec=`** добавляет случайную задержку, чтобы десяток серверов не ломился в S3 одновременно.
- Таймер по умолчанию запускает сервис с тем же именем, поэтому `Unit=` не нужен.

```bash
systemctl daemon-reload
systemctl enable --now backup-panel.timer
systemctl start backup-panel.service   # первый прогон руками
journalctl -u backup-panel.service -n 50
systemctl list-timers backup-panel.timer
```

Как вообще устроены сервисы и таймеры, будет в гайде [systemd-сервисы](/gaidy/systemd-servisy/).

## Правило 3-2-1

Три копии данных, на двух разных носителях, одна из них в другом месте. На практике для панели: рабочая база, дамп на локальном диске, репозиторий restic у другого провайдера. S3 в том же дата-центре, что и сервер, это не «другое место».

## Проверка восстановления

Раз в месяц, а также после каждого обновления панели или Postgres. Сначала список снимков и восстановление в отдельную папку:

```bash
set -a; . /etc/restic/env; set +a
restic snapshots --tag panel
restic restore latest --tag panel --target /tmp/restore-test
ls -la /tmp/restore-test/var/backups/panel/ /tmp/restore-test/opt/remnawave/
```

Потом дамп в **тестовую** базу рядом с рабочей. Пустую базу создаём из `template0`, как советует документация `pg_restore`:

```bash
docker exec remnawave-db sh -c 'createdb -U "$POSTGRES_USER" -T template0 restore_test'

docker exec -i remnawave-db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d restore_test --no-owner --exit-on-error' \
  < /tmp/restore-test/var/backups/panel/panel.dump

docker exec remnawave-db sh -c 'psql -U "$POSTGRES_USER" -d restore_test -c "\dt"'
```

Таблицы на месте, количество строк в главных таблицах похоже на правду: бэкап живой. Убираем за собой:

```bash
docker exec remnawave-db sh -c 'dropdb -U "$POSTGRES_USER" restore_test'
rm -rf /tmp/restore-test
```

> [!WARNING]
> Боевое восстановление поверх рабочей базы делается с `--clean --if-exists` (`--if-exists` без `--clean` не работает) и при остановленном приложении. `pg_restore -j` для ускорения работает только с файлом, не со стандартным вводом, и несовместим с `--single-transaction`.

> [!IMPORTANT]
> `pg_dump` новее сервера умеет снимать дампы со старых версий, а вот загрузка дампа в **более старую** мажорную версию Postgres не гарантируется. Восстанавливай на ту же или более новую версию. Если панель после restore не стартует, в сообществе помогало снести Redis: [база](/baza/set/bekapy/).

## Источники

- [PostgreSQL: pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [PostgreSQL: pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)
- [PostgreSQL: File System Level Backup](https://www.postgresql.org/docs/current/backup-file.html)
- [PostgreSQL: Upgrading a PostgreSQL Cluster](https://www.postgresql.org/docs/current/upgrading.html)
- [Docker Official Image: postgres](https://hub.docker.com/_/postgres)
- [restic: Preparing a new repository](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)
- [restic: Backing up](https://restic.readthedocs.io/en/stable/040_backup.html)
- [restic: Working with repositories](https://restic.readthedocs.io/en/stable/045_working_with_repos.html)
- [restic: Restoring from backup](https://restic.readthedocs.io/en/stable/050_restore.html)
- [restic: Removing backup snapshots](https://restic.readthedocs.io/en/stable/060_forget.html)
- [restic: Scripting](https://restic.readthedocs.io/en/stable/075_scripting.html)
- [restic CHANGELOG](https://github.com/restic/restic/blob/master/CHANGELOG.md)
- [systemd.timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)
- [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
