---
title: "systemd: свой сервис и таймеры вместо cron"
lede: "Unit для бинарника, который сам поднимается после падения, не работает от root и пишет логи туда, где их можно найти. Плюс таймеры, которые не теряют запуски после ребута."
category: server
weight: 5
actual: "systemd 255 (Ubuntu 24.04), Debian 12; Xray из официального Xray-install"
lastmod: 2026-09-23
---

`nohup ./xray &` в `screen` живёт ровно до первого ребута или OOM. systemd уже стоит на сервере, умеет перезапускать, ограничивать и логировать. Осталось написать ему десять строк.

> [!NOTE]
> Нода Remnawave работает в Docker, и Xray внутри контейнера запускает supervisor, а не systemd (например, лог лежит в `/var/log/supervisor/xray.out.log` внутри `remnanode`, см. [Мониторинг](/baza/set/monitoring/)). Этот гайд для «голого» Xray, самописных ботов, скриптов и всего, что живёт вне контейнеров.

## Минимальный unit

Официальный установщик [XTLS/Xray-install](https://github.com/XTLS/Xray-install) кладёт бинарник в `/usr/local/bin/xray`, конфиг в `/usr/local/etc/xray/config.json` и сам создаёт unit. Ниже unit того же устройства, но с отдельным пользователем.

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin xray
```

```ini {name="/etc/systemd/system/xray.service"}
[Unit]
Description=Xray
After=network.target nss-lookup.target
# не больше 5 запусков за 5 минут, потом unit уходит в failed
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=xray
ExecStartPre=/usr/local/bin/xray run -test -config /usr/local/etc/xray/config.json
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

`ExecStartPre` с флагом `-test` проверяет конфиг без запуска сервера: битый JSON не дойдёт до основного процесса. `LimitNOFILE` задаёт лимит дескрипторов для процесса, подробнее о том, зачем он ноде, в гайде [sysctl для ноды](/gaidy/sysctl-dlya-nody/).

```bash
systemctl daemon-reload
systemctl enable --now xray
systemctl status xray
```

`daemon-reload` нужен после любой правки файлов unit'ов, `enable --now` включает автозапуск и сразу стартует.

### Restart=on-failure или always

| Причина выхода | on-failure | always |
|---|---|---|
| Код 0 или SIGHUP/SIGINT/SIGTERM/SIGPIPE | нет | да |
| Ненулевой код выхода | да | да |
| Убит сигналом, core dump | да | да |
| Таймаут, watchdog, OOM | да | да |

`systemctl stop` не вызывает перезапуск ни в одном режиме. `man systemd.service` рекомендует `on-failure` для долгоживущих сервисов: если процесс завершился чисто, значит, так и задумано. `always` оставь для программ, которые выходят с кодом 0 по ошибке.

### RestartSec и лимит запусков

`RestartSec` по умолчанию 100 мс. `StartLimitIntervalSec=` и `StartLimitBurst=` задаются **в секции `[Unit]`**, а не `[Service]`, и по умолчанию равны 10 секундам и 5 запускам (`DefaultStartLimitIntervalSec`/`DefaultStartLimitBurst` в `systemd-system.conf`).

> [!IMPORTANT]
> Посчитай арифметику. С `RestartSec=5` пять запусков занимают минимум 20 секунд и в окно 10 секунд не попадут никогда: сломанный сервис будет перезапускаться бесконечно. Поэтому окно в примере увеличено до 300 секунд. Когда лимит сработал, unit остаётся в `failed`; сбросить счётчик можно командой `systemctl reset-failed xray`.

## Логи

Всё, что сервис пишет в stdout/stderr, попадает в журнал:

```bash
journalctl -u xray -f                      # хвост в реальном времени
journalctl -u xray --since "-1h"           # за последний час
journalctl -u xray --since today -p err    # сегодня, только ошибки и выше
journalctl -u xray -b -e                   # с текущей загрузки, сразу в конец
```

`--since` понимает абсолютные даты (`"2026-09-23 18:00"`), слова `yesterday`, `today`, `now` и относительные сдвиги с `-`/`+`.

## Переопределения: systemctl edit

Unit, который поставил пакет или установщик, руками не правят: следующее обновление перезапишет изменения. Правильный путь: drop-in.

```bash
systemctl edit xray
```

Откроется редактор. Всё, что сохранишь, ляжет в `/etc/systemd/system/xray.service.d/override.conf`, а `daemon-reload` systemd сделает сам. Проверить итог (основной файл плюс все drop-in):

```bash
systemctl cat xray
```

Большинство директив в drop-in просто заменяют значение. Но списочные, как `ExecStart=`, добавляются к имеющимся, поэтому сначала их сбрасывают пустым присваиванием:

```ini {name="/etc/systemd/system/xray.service.d/override.conf"}
[Service]
ExecStart=
ExecStart=/usr/local/bin/xray run -confdir /usr/local/etc/xray/conf.d
```

Без пустой строки у сервиса окажется две команды `ExecStart`, а для обычного (не `oneshot`) сервиса разрешена ровно одна, и unit не запустится.

## Базовое усиление

Добавляем в `[Service]` (прямо в unit или через `systemctl edit`):

```ini {name="/etc/systemd/system/xray.service.d/hardening.conf"}
[Service]
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log/xray
ProtectHome=true
PrivateTmp=true
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

Что делает каждая строка (по `man systemd.exec`):

- **`NoNewPrivileges=true`**: процесс и его потомки не могут получить новые привилегии через `execve()` (setuid/setgid-биты, file capabilities). Самый простой и эффективный запрет на повышение привилегий.
- **`ProtectSystem=strict`**: вся файловая система только для чтения, кроме `/dev`, `/proc`, `/sys`. Исключения задаются через `ReadWritePaths=`; каталог должен существовать и принадлежать пользователю сервиса (`install -d -o xray -g xray /var/log/xray`). Для логов удобнее `LogsDirectory=xray`: systemd сам создаст `/var/log/xray`, отдаст его пользователю из `User=` и исключит из read-only.
- **`ProtectHome=true`**: `/home`, `/root` и `/run/user` пустые и недоступные. Вариант `read-only` оставляет их только для чтения.
- **`PrivateTmp=true`**: свои `/tmp` и `/var/tmp`, невидимые остальным процессам и очищаемые после остановки. С `ProtectSystem=strict` они остаются доступными на запись.
- **`AmbientCapabilities=CAP_NET_BIND_SERVICE`**: даёт непривилегированному пользователю право слушать порты ниже 1024, то есть 443 без root. `CapabilityBoundingSet=` при этом отрезает все остальные capabilities.

> [!WARNING]
> Официальный unit Xray выдаёт ещё и `CAP_NET_ADMIN`. Если конфиг использует функции, которым нужен `CAP_NET_ADMIN`, а ты оставил только `CAP_NET_BIND_SERVICE`, Xray упадёт при старте. Смотри `journalctl -u xray` и добавь capability обратно в обе строки.

После изменений:

```bash
systemctl daemon-reload && systemctl restart xray
systemd-analyze security xray.service
```

`systemd-analyze security` проверяет настройки песочницы и выводит итоговую оценку «экспозиции» от 0.0 до 10.0: чем меньше, тем строже. Это ориентир, а не аудит: он видит только песочницу самого systemd. Без имени unit'а команда выводит сводку по всем запущенным сервисам.

## Таймеры вместо cron

Таймер состоит из двух файлов: `.service` делает работу, `.timer` решает когда. Пример: ежедневное обновление диапазонов Cloudflare скриптом из гайда [nginx за Cloudflare](/gaidy/nginx-za-cloudflare/). То же подходит для бэкапов (гайд [Бэкапы на restic](/gaidy/bekapy-restic/)) и продления сертификатов, которое в сообществе часто висит в cron (см. [Сертификаты](/baza/set/sertifikaty/)).

```ini {name="/etc/systemd/system/cf-ips-update.service"}
[Unit]
Description=Update Cloudflare IP ranges

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cf-ips-update
```

```ini {name="/etc/systemd/system/cf-ips-update.timer"}
[Unit]
Description=Daily Cloudflare IP ranges update

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
```

- **`OnCalendar=`**: календарное выражение. `daily` означает `*-*-* 00:00:00`, `weekly` означает `Mon *-*-* 00:00:00`, диапазоны дней пишутся как `Mon..Fri`.
- **`RandomizedDelaySec=`**: случайная задержка от нуля до указанного значения, чтобы десяток серверов не ходил за одним и тем же ресурсом в одну секунду.
- **`Persistent=true`**: время последнего запуска хранится на диске. Если сервер был выключен в момент срабатывания, задача выполнится сразу после включения (с учётом `RandomizedDelaySec`). Работает только для `OnCalendar=`. Именно этого не умеет обычный cron.
- **`Unit=`** не указан: по умолчанию таймер запускает сервис с тем же именем.

Проверить выражение, не дожидаясь ночи:

```bash
systemd-analyze calendar --iterations=3 '*-*-* 04:00:00'
```

Команда покажет нормализованную форму и ближайшие срабатывания. Включаем **таймер**, а не сервис, и проверяем:

```bash
systemctl daemon-reload
systemctl enable --now cf-ips-update.timer
systemctl list-timers
systemctl start cf-ips-update.service   # прогнать задачу вручную
journalctl -u cf-ips-update.service --since today
```

> [!TIP]
> Если к моменту срабатывания таймера сервис ещё работает, systemd не запускает его повторно, а просто оставляет как есть. Два наложившихся друг на друга бэкапа, как бывает с cron, здесь не получатся.

## Дальше

- Алерты на упавшие сервисы и простые проверки ноды: [Мониторинг](/baza/set/monitoring/) и гайд [Мониторинг на коленке](/gaidy/monitoring-na-kolenke/).
- Типовые падения Xray и транспортов с фиксами: [Ошибки транспортов](/baza/transporty/oshibki-fiksy/), [индекс ошибок](/baza/indeksy/oshibki/).
- Установщики нод и панелей, которые ставят свои unit'ы: [Установщики](/baza/skripty/ustanovschiki/).

## Источники

- [systemd.service(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html): `Restart=`, `RestartSec=`, `ExecStart=`, `Type=oneshot`
- [systemd.unit(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html): `StartLimitIntervalSec=`, `StartLimitBurst=`, drop-in каталоги
- [systemd-system.conf(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd-system.conf.html): `DefaultStartLimitIntervalSec=`, `DefaultStartLimitBurst=`
- [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html): `NoNewPrivileges=`, `ProtectSystem=`, `ReadWritePaths=`, `ProtectHome=`, `PrivateTmp=`, `AmbientCapabilities=`, `CapabilityBoundingSet=`, `LimitNOFILE=`, `LogsDirectory=`
- [systemd.timer(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html), [systemd.time(7)](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html), [systemd.special(7)](https://www.freedesktop.org/software/systemd/man/latest/systemd.special.html): `timers.target`
- [systemctl(1)](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html): `edit`, `cat`, `enable --now`, `reset-failed`, `list-timers`
- [systemd-analyze(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-analyze.html): `security`, `calendar`
- [journalctl(1)](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html): `-u`, `-f`, `--since`, `-p`, `-b`, `-e`
- Xray: [команды `xray run`](https://xtls.github.io/en/document/command.html), [XTLS/Xray-install](https://github.com/XTLS/Xray-install)
