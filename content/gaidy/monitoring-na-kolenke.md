---
title: "Мониторинг на коленке: Uptime Kuma, vnStat и скрипт с алертом в Telegram"
lede: "Узнать, что нода легла, раньше клиентов, и не поднимать ради этого Prometheus, Grafana и три экспортёра."
category: server
weight: 9
actual: "Uptime Kuma 2.x, vnStat 2.x, Debian 12 / Ubuntu 24.04"
lastmod: 2026-09-23
---

Классический мониторинг выглядит так: о падении ноды сообщает клиент в поддержке, причём через час. Полноценный стек с Prometheus и Grafana это лечит, но на пять нод и одну панель он весит больше, чем всё остальное хозяйство. Ниже три простых слоя: внешние проверки, учёт трафика и скрипт на случай, когда нужна своя логика.

## Что используют в сообществе

Прежде чем изобретать, посмотри, на чём сидят другие. В [базе по мониторингу](/baza/set/monitoring/) чаще всего встречаются Uptime Kuma для статусов, Beszel для нагрузки нод, связка XrayChecker + Uptime Kuma для проверки самих прокси-конфигов из подписки, а также Gatus, Kener, Netdata и Zabbix. Готовые скрипты под Remnawave собраны в [скриптах мониторинга](/baza/skripty/monitoring/). Этот гайд про минимальный набор, который ставится за вечер.

## Uptime Kuma

Uptime Kuma проверяет сервисы снаружи и шлёт уведомления. Ставить её лучше **не на ту ноду, которую она мониторит**: упавший сервер сам о своём падении не расскажет.

### Запуск

Официальный compose из README проекта, с одной правкой: порт публикуем только на localhost.

```yaml {name="docker-compose.yml"}
services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    restart: unless-stopped
    volumes:
      - ./data:/app/data
    ports:
      - "127.0.0.1:3001:3001"
```

```bash
mkdir -p /opt/uptime-kuma && cd /opt/uptime-kuma
# положи сюда docker-compose.yml из примера выше
docker compose up -d
```

Вариант одной командой из того же README:

```bash
docker run -d --restart=always -p 127.0.0.1:3001:3001 -v uptime-kuma:/app/data --name uptime-kuma louislam/uptime-kuma:2
```

Все данные (мониторы, история, настройки) лежат в `/app/data`, поэтому том обязателен. Бэкап Kuma сводится к копии каталога `./data`.

> [!WARNING]
> В официальном примере стоит `"3001:3001"`, и тогда Kuma слушает на всех интерфейсах, а Docker откроет порт в обход твоего файрвола. Отсюда `127.0.0.1:` в примере выше. Подробнее про Docker и файрвол в [гайде по nftables](/gaidy/nftables-minimalnyy-fayrvol/).

> [!CAUTION]
> Том с данными не клади на NFS: в README прямо сказано, что сетевые файловые системы не поддерживаются. Только локальный каталог или Docker-том.

### Как зайти в интерфейс

Самый простой способ: SSH-туннель со своей машины.

```bash
ssh -L 3001:127.0.0.1:3001 root@203.0.113.10
```

Пока сессия открыта, интерфейс доступен на `http://localhost:3001`. При первом входе Kuma 2.x спросит, какую базу использовать (для пары десятков мониторов хватит SQLite, «рекомендуется для небольших установок»), и попросит создать администратора.

Если нужен постоянный доступ или публичная страница статусов, ставь реверс-прокси с HTTPS. Kuma работает через WebSocket, поэтому в nginx нужны заголовки `Upgrade` и `Connection`:

```nginx {name="/etc/nginx/sites-available/status.conf"}
location / {
    proxy_pass         http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host $host;
}
```

> [!NOTE]
> Kuma не работает в подкаталоге вида `example.com/kuma`. Нужен отдельный домен или поддомен.

### Какие проверки ставить

| Тип в интерфейсе | Что проверяет | Когда нужен |
|---|---|---|
| HTTP(s) | Код ответа по URL | Панель, подписка, сайт |
| HTTP(s) - Keyword | Что в ответе есть (или нет) нужное слово | Страница отдаёт 200, но с ошибкой внутри |
| TCP Port | Что порт принимает соединение | Порт ноды (443 и т.п.), SSH, база |
| Ping | ICMP-ответ | Сервер вообще жив |
| Push | Что сервер сам дёрнул выданный URL вовремя | Cron-задачи, бэкапы, свои скрипты |

Для Keyword есть галка **Invert Keyword**: тревога, если слово *появилось*. Удобно ловить `error` или `Bad Gateway` на странице, которая формально отвечает 200.

Минимальный интервал проверок по README 20 секунд. Параметр **Retries** задаёт, сколько неудачных проверок подряд нужно для статуса «упал»: поставь 2–3, иначе каждый сетевой чих будет будить тебя ночью.

> [!TIP]
> TCP-проверка порта ноды говорит только, что порт открыт. Работает ли сам прокси, она не знает. Для этого сообщество ставит XrayChecker, который гоняет трафик через конфиги подписки и отдаёт статусы в Kuma: см. [базу](/baza/set/monitoring/).

### Уведомления в Telegram

1. В Telegram открой [@BotFather](https://t.me/BotFather), создай бота командой `/newbot`, сохрани токен.
2. Напиши своему боту любое сообщение (или добавь его в группу и напиши там). Пока ты боту не написал, узнать chat id не получится.
3. В Kuma: **Settings → Notifications → Set Up Notification**, тип Telegram, вставь **Bot Token**.
4. Нажми **Auto Get** рядом с полем **Chat ID**: Kuma сама вызовет `getUpdates` и подставит id последнего чата. Если не сработало, открой в браузере `https://api.telegram.org/bot<TOKEN>/getUpdates` и найди `"chat":{"id":...}`.
5. Для групп с топиками есть необязательное поле **Message Thread ID**.

Отправь тестовое уведомление и включи его на нужных мониторах (или отметь **Apply on all existing monitors**).

## vnStat: сколько трафика ушло

У многих хостеров тариф ограничен по трафику, и узнавать о превышении из счёта неприятно. vnStat считает трафик по интерфейсам и почти не ест ресурсов.

```bash
apt install vnstat
systemctl enable --now vnstat
```

Работу делит на две части: демон `vnstatd` снимает счётчики интерфейсов и пишет в базу `/var/lib/vnstat/`, а команда `vnstat` только показывает. При первом запуске без базы демон сам создаёт записи для всех интерфейсов, кроме `lo`, `lo0` и `sit0`. Руками добавлять ничего не нужно, но первые цифры появятся не сразу, а после первого сохранения базы.

```bash
vnstat            # сводка по всем интерфейсам
vnstat -d         # по дням (по умолчанию последние 30)
vnstat -m         # по месяцам (последние 12)
vnstat -h         # по часам
vnstat -5         # пятиминутки за последние часы
vnstat -l -i eth0 # живая скорость, выход по Ctrl+C
vnstat -tr 10     # средняя скорость за 10 секунд
vnstat -m --json  # то же в JSON, для скриптов
```

Если хостер считает месяц не с первого числа, поправь `MonthRotate` в `/etc/vnstat.conf` (значение 1–28) и перезапусти сервис. Уже собранные данные при этом не пересчитываются.

> [!NOTE]
> vnStat учитывает только трафик интерфейса целиком, без разбивки по клиентам или контейнерам. Для учёта по пользователям смотри статистику панели.

## Свой healthcheck с алертом в Telegram

Kuma видит сервер снаружи. Изнутри бывает полезно проверить то, чего снаружи не видно: заполненный диск, упавший контейнер, локальный порт базы. Для этого хватит bash, `curl` и таймера systemd.

Токен и chat id держим отдельно от скрипта:

```ini {name="/etc/healthcheck.env"}
TG_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TG_CHAT=123456789
```

```bash
chmod 600 /etc/healthcheck.env
```

Сам скрипт. Он шлёт сообщение только при **смене** состояния, иначе упавший сервис будет спамить каждые пять минут.

```bash {name="/usr/local/bin/healthcheck.sh"}
#!/usr/bin/env bash
set -u
STATE_DIR=/var/lib/healthcheck
mkdir -p "$STATE_DIR"
HOST=$(hostname)

tg() {
  curl -s -m 10 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" \
    --data-urlencode text="$1" > /dev/null
}

# report <имя> <0|1>: пишем в Telegram, только если статус изменился
report() {
  local name=$1 ok=$2 file="$STATE_DIR/$1" prev
  prev=$(cat "$file" 2>/dev/null || echo 1)
  if [ "$ok" != "$prev" ]; then
    if [ "$ok" = 1 ]; then tg "[OK] ${HOST}: ${name} снова в порядке"
    else tg "[DOWN] ${HOST}: ${name} не отвечает"; fi
    echo "$ok" > "$file"
  fi
}

check_http() {   # код 2xx или 3xx считаем успехом
  local code
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$1")
  [ "$code" -ge 200 ] && [ "$code" -lt 400 ]
}

check_tcp() {    # bash умеет открывать TCP через /dev/tcp
  timeout 5 bash -c "</dev/tcp/$1/$2" 2>/dev/null
}

check_disk() {   # занято меньше 90% на /
  local used
  used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
  [ "$used" -lt 90 ]
}

check() {        # check <имя> <команда проверки...>
  local name=$1; shift
  if "$@"; then report "$name" 1; else report "$name" 0; fi
}

check panel    check_http "https://panel.example.com"
check postgres check_tcp 127.0.0.1 5432
check disk     check_disk
```

```bash
chmod 700 /usr/local/bin/healthcheck.sh
```

Сервис и таймер: запуск через две минуты после загрузки и дальше каждые пять минут.

```ini {name="/etc/systemd/system/healthcheck.service"}
[Unit]
Description=Healthcheck with Telegram alerts

[Service]
Type=oneshot
EnvironmentFile=/etc/healthcheck.env
ExecStart=/usr/local/bin/healthcheck.sh
```

```ini {name="/etc/systemd/system/healthcheck.timer"}
[Unit]
Description=Run healthcheck every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now healthcheck.timer
systemctl list-timers healthcheck.timer   # когда следующий запуск
journalctl -u healthcheck.service -n 20   # что было в прошлый раз
```

Таймер без `Unit=` запускает сервис с тем же именем. Подробнее про юниты и таймеры будет в гайде [про systemd-сервисы](/gaidy/systemd-servisy/).

> [!TIP]
> Можно совместить со Uptime Kuma: создай монитор типа Push, Kuma выдаст URL, который нужно дёргать не реже заданного интервала. Добавь `curl -s -m 10 "<push-url>" > /dev/null` в конец скрипта, и Kuma поднимет тревогу, если скрипт перестал запускаться вовсе.

> [!CAUTION]
> Не пиши токен бота прямо в скрипт, который потом уедет в git или в чат «посмотрите, почему не работает». С токеном любой сможет писать от имени бота.

## Доступность из России через host.pink

Kuma на зарубежном сервере не скажет, открывается ли нода у пользователей в РФ. Разово это можно проверить нашим API: пробы из российских домашних провайдеров, дата-центров и других стран.

```bash
curl "https://host.pink/check/example.com?t=http&json"
curl "https://host.pink/check/203.0.113.10:443?t=tcp&json"
```

Тип задаётся в `t`: `http`, `ping`, `tcp`, `dns`, `mtr`. В JSON у каждой пробы есть страна (`cc`), флаг домашнего провайдера (`home`) и `state`: `up`, `slow`, `down` или `none`. Российские пробы идут первыми. Отфильтровать только их:

```bash
curl -s "https://host.pink/check/203.0.113.10:443?t=tcp&json" \
  | jq -r '.results[] | select(.cc=="RU") | "\(.state)\t\(.city)\t\(.text)"'
```

> [!IMPORTANT]
> Лимит 30 проверок в минуту с одного IP, одинаковая проверка в течение двух минут отдаётся из кэша. Это инструмент для разбора «почему не открывается», а не для мониторинга каждые 20 секунд. Для постоянного наблюдения ставь свою Kuma. Как читать результаты, разобрано в гайде [«Сайт не открывается из РФ»](/gaidy/sayt-ne-otkryvaetsya-iz-rf/).

## Источники

- [Uptime Kuma: README (установка, типы мониторов)](https://github.com/louislam/uptime-kuma)
- [Uptime Kuma: официальный compose.yaml](https://github.com/louislam/uptime-kuma/blob/master/compose.yaml)
- [Uptime Kuma wiki: Reverse Proxy](https://github.com/louislam/uptime-kuma/wiki/Reverse-Proxy)
- [vnstat(1)](https://humdi.net/vnstat/man/vnstat.html), [vnstatd(8)](https://humdi.net/vnstat/man/vnstatd.html), [vnstat.conf(5)](https://humdi.net/vnstat/man/vnstat.conf.html)
- [Telegram Bot API: Making requests, sendMessage, getUpdates](https://core.telegram.org/bots/api)
- [systemd.timer(5)](https://man7.org/linux/man-pages/man5/systemd.timer.5.html)
