---
title: "Диск кончился: найти и почистить"
lede: "No space left on device на ноде или сервере с панелью. Как за пять минут найти, что съело место, освободить его и не наступить на те же грабли через месяц."
category: server
weight: 7
actual: "Ubuntu 24.04 / Debian 12, systemd 252+, Docker Engine 28+"
lastmod: 2026-09-23
---

Диск кончается всегда в самый неудобный момент: Postgres перестаёт писать, бот падает, Docker не может создать контейнер. На VPS за 3 евро с диском на 10 ГБ этот момент наступает быстрее, чем кажется.

## Шаг 1. Место или иноды

```bash
df -hT
df -i
```

`df -h` показывает занятые блоки, `df -i` иноды. Если `IUse%` в `df -i` на 100%, а место ещё есть, проблема не в размере, а в количестве файлов: миллионы мелких файлов сессий, кэша, писем. Искать надо не тяжёлые папки, а многолюдные:

```bash
du --inodes -x -d 3 / 2>/dev/null | sort -n | tail -20
```

> [!NOTE]
> `df` может показывать 100% ещё до того, как места нет совсем. На ext4 по умолчанию 5% блоков зарезервировано за root, чтобы системные демоны работали, когда обычные процессы уже не могут писать. Не рассчитывай на этот запас: процессы от root могут занять и его.

Заодно проверь, что диск не отвалился, а именно заполнился. Набор из [мониторинга в базе](/baza/set/monitoring/):

```bash
dmesg | tail -40 | grep -iE 'error|fail|oom|bus|I/O'
```

## Шаг 2. Кто занял место

Самые тяжёлые каталоги, не выходя за пределы корневой ФС (`-x` не даёт du уйти в `/proc` и примонтированные диски):

```bash
du -xh -d 1 / 2>/dev/null | sort -h | tail -15
```

Спускаешься глубже в самый толстый каталог и повторяешь. Обычные подозреваемые: `/var/lib/docker`, `/var/log`, `/var/cache/apt`, домашние каталоги с бэкапами.

Крупные файлы одним списком:

```bash
find / -xdev -type f -size +200M -printf '%s\t%p\n' 2>/dev/null | sort -n | tail -20
```

Удобнее всего `ncdu`: интерактивное дерево, сортировка по размеру, удаление клавишей `d` с подтверждением.

```bash
apt install ncdu
ncdu -x /
```

> [!TIP]
> На боевом сервере запускай `ncdu -r -x /`: `-r` отключает удаление, и случайное нажатие `d` ничего не снесёт. Если места нет совсем и `apt install` не проходит, обходись `du`.

## journald

Системный журнал по умолчанию занимает до 10% файловой системы, но не больше 4 ГБ (`SystemMaxUse`). На маленьком диске это ощутимо.

```bash
journalctl --disk-usage
```

Срочно ужать:

```bash
journalctl --rotate --vacuum-size=200M
# или оставить только последнюю неделю
journalctl --rotate --vacuum-time=7d
```

`--vacuum-*` удаляет только архивные файлы журнала, активные не трогает. Поэтому вместе с ним нужен `--rotate`: он архивирует текущие файлы, и чистка работает по полной.

Чтобы не повторилось, задай лимит через drop-in, а не правкой основного файла (так рекомендует man journald.conf):

```bash
mkdir -p /etc/systemd/journald.conf.d
```

```ini {name="/etc/systemd/journald.conf.d/size.conf"}
[Journal]
SystemMaxUse=300M
MaxRetentionSec=1month
```

```bash
systemctl restart systemd-journald
```

Перезапуск journald безопасен, это прямо сказано в документации. `SystemMaxUse` действует на постоянный журнал в `/var/log/journal`. Если задан и `SystemKeepFree`, journald соблюдает оба лимита и берёт меньший.

## Логи Docker-контейнеров

Драйвер `json-file` по умолчанию пишет без ограничения размера. Это главный кандидат на сервере с ботом или панелью.

`docker system df` логи не показывает. Размер лога конкретного контейнера:

```bash
du -h "$(docker inspect --format='{{.LogPath}}' remnawave_bot)"
```

Все контейнеры сразу, самые толстые внизу:

```bash
docker ps -aq | xargs docker inspect --format='{{.LogPath}}' | xargs du -h 2>/dev/null | sort -h
```

### Почему не rm

Файл лога держит открытым демон Docker. `rm` убирает только имя: по man unlink(2) файл продолжает существовать, пока закрыт не последний дескриптор. Место не освободится, а лог станет невидимым для `du`. Это классическая ситуация «удалил 5 ГБ, а df не изменился» (см. ниже про `lsof +L1`).

Если место нужно прямо сейчас, файл обнуляют на месте, не удаляя:

```bash
truncate -s 0 "$(docker inspect --format='{{.LogPath}}' remnawave_bot)"
```

> [!WARNING]
> Документация Docker прямо предупреждает: файлы json-file предназначены только для демона, вмешательство внешних инструментов может привести к непредсказуемому поведению. `truncate` здесь аварийная мера, а не регламент. Правильное решение: лимит `max-size`/`max-file` и пересоздание контейнеров. Как это сделать, в гайде [Docker для панелей и ботов](/gaidy/docker-dlya-paneley/).

## Образы, кэш сборки, тома

Старые образы копятся после каждого `docker compose pull`, в сообществе это одна из типовых причин забитого диска ([ошибки и фиксы](/baza/paneli/oshibki-fiksy/)).

```bash
docker system df
docker system df -v
```

Колонка `RECLAIMABLE` показывает, сколько можно вернуть. Дальше по нарастающей:

```bash
docker image prune        # dangling-образы (<none>)
docker builder prune      # кэш сборки: бот с build: копит его на каждой пересборке
docker image prune -a     # все образы, которые не использует ни один контейнер
```

> [!CAUTION]
> `docker system prune -a --volumes` удаляет остановленные контейнеры, неиспользуемые сети, все неиспользуемые образы, кэш сборки и анонимные тома. Остановленный на время стек после этого придётся качать или собирать заново, а сеть, созданная остановленным проектом, пропадёт. Перед запуском посмотри `docker ps -a` и убедись, что нужное запущено.

## apt

Кэш скачанных пакетов лежит в `/var/cache/apt/archives/`:

```bash
apt-get clean
apt-get autoremove --purge
```

`clean` удаляет все скачанные `.deb` из кэша. `autoremove` удаляет пакеты, которые ставились как зависимости и больше не нужны, `--purge` заодно их конфиги. Посмотри список перед подтверждением: на серверах, где что-то собирали руками, туда иногда попадает нужное.

## Удалённые, но открытые файлы

Удалил большой лог, а `df` показывает то же самое. Файл ещё открыт процессом, и место вернётся только после закрытия дескриптора. Найти такие файлы:

```bash
lsof +L1
```

`+L1` выбирает открытые файлы, у которых не осталось ни одного имени в ФС. В колонке `SIZE/OFF` размер, в `COMMAND` и `PID` процесс, который держит файл. Лечится перезапуском этого процесса: `systemctl restart <сервис>` или `docker restart <контейнер>`. Дескриптор закроется, и место вернётся.

Урок на будущее: лог, в который кто-то пишет, не удаляют, а обнуляют (`truncate -s 0 файл`) или отдают logrotate.

## logrotate: чтобы свои логи не росли

Логи сервисов, которые пишут в файлы (nginx, Xray с `access.log`, свои скрипты), ротирует logrotate. Он запускается ежедневно по таймеру или cron и читает конфиги из `/etc/logrotate.d/`.

```ini {name="/etc/logrotate.d/remnanode"}
/var/log/remnanode/*.log {
    daily
    rotate 7
    maxsize 200M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

- `maxsize` ротирует раньше срока, если файл вырос больше порога.
- `copytruncate` копирует лог и обнуляет оригинал на месте. По man logrotate нужен, когда программе нельзя сказать закрыть лог. Строки, записанные между копированием и обнулением, могут потеряться.
- Если сервис умеет переоткрывать логи, вместо `copytruncate` используй `postrotate ... endscript` с командой перезагрузки.

Проверить конфиг, ничего не меняя, и потом прогнать принудительно:

```bash
logrotate -d /etc/logrotate.d/remnanode
logrotate -f /etc/logrotate.d/remnanode
```

## Чек-лист на будущее

- Лимит логов Docker в `/etc/docker/daemon.json` и пересозданные после этого контейнеры.
- `SystemMaxUse` для journald в drop-in.
- logrotate на всё, что пишет в `/var/log` мимо journald.
- `docker image prune` после обновлений.
- Алерт на заполнение диска раньше, чем он станет 100%. Как собрать простой мониторинг, в гайде [мониторинг на коленке](/gaidy/monitoring-na-kolenke/) и в базе: [мониторинг](/baza/set/monitoring/), [скрипты мониторинга](/baza/skripty/monitoring/).

## Источники

- [df(1)](https://man7.org/linux/man-pages/man1/df.1.html), [du(1)](https://man7.org/linux/man-pages/man1/du.1.html), [sort(1)](https://man7.org/linux/man-pages/man1/sort.1.html), [find(1)](https://man7.org/linux/man-pages/man1/find.1.html), [truncate(1)](https://man7.org/linux/man-pages/man1/truncate.1.html)
- [mke2fs(8): резерв 5% для root](https://man7.org/linux/man-pages/man8/mke2fs.8.html)
- [ncdu(1)](https://manpages.debian.org/bookworm/ncdu/ncdu.1.en.html)
- [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html), [journald.conf(5)](https://man7.org/linux/man-pages/man5/journald.conf.5.html), [systemd-journald.service(8)](https://man7.org/linux/man-pages/man8/systemd-journald.service.8.html)
- [Docker: JSON File logging driver](https://docs.docker.com/engine/logging/drivers/json-file/)
- [docker system df](https://docs.docker.com/reference/cli/docker/system/df/), [docker system prune](https://docs.docker.com/reference/cli/docker/system/prune/), [docker image prune](https://docs.docker.com/reference/cli/docker/image/prune/), [docker buildx prune](https://docs.docker.com/reference/cli/docker/buildx/prune/)
- [apt-get(8)](https://manpages.debian.org/bookworm/apt/apt-get.8.en.html)
- [unlink(2)](https://man7.org/linux/man-pages/man2/unlink.2.html), [lsof(8)](https://man7.org/linux/man-pages/man8/lsof.8.html)
- [logrotate(8)](https://manpages.debian.org/bookworm/logrotate/logrotate.8.en.html)
