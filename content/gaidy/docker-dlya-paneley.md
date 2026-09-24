---
title: "Docker для панелей и ботов на VPS"
lede: "Панель, бот и кабинет в контейнерах: как не выставить базу в интернет, не утонуть в логах, связать сети и обновляться без сюрпризов."
category: server
weight: 6
actual: "Docker Engine 28+ с Compose v2, Ubuntu 24.04 / Debian 12"
lastmod: 2026-09-23
---

Docker удобен ровно до момента, когда выясняется, что порт бота торчит в мир мимо файрвола, а логи контейнера съели диск. Ниже то, что стоит сделать сразу после `docker compose up -d`, а не после инцидента.

## Порты: только 127.0.0.1

По умолчанию Docker публикует порт на всех адресах хоста: `0.0.0.0` и `[::]`. Документация прямо называет это небезопасным: порт становится доступен не только хосту, но и всему интернету.

Всё, что стоит за reverse proxy (панель, API бота, страница подписки, кабинет), публикуй только на loopback:

```yaml {name="docker-compose.yml"}
services:
  bot:
    ports:
      - "127.0.0.1:8080:8080"
```

Caddy или nginx на хосте ходит на `127.0.0.1:8080`, а снаружи порт не виден. Если прокси тоже в контейнере и в той же сети, `ports:` не нужен вовсе: прокси обращается к сервису по имени (`remnawave:3000`, `remnawave_bot:8080`).

Проверить, что торчит наружу:

```bash
ss -tlnp | grep docker-proxy
```

Строка с `0.0.0.0:8080` или `[::]:8080` значит, что порт открыт миру. В сообществе это регулярная находка: [порт 8080 бота открыт наружу](/baza/paneli/docker-compose/), лечится префиксом `127.0.0.1:`.

> [!WARNING]
> До Docker 28.0 порт, опубликованный на `127.0.0.1`, был доступен хостам из того же L2-сегмента (соседям по коммутатору у хостера). Это сказано в документации Docker. Если движок старше, обновись.

Чтобы новые сети по умолчанию публиковали порты на loopback, в `/etc/docker/daemon.json` есть `default-network-opts`:

```json {name="/etc/docker/daemon.json"}
{
  "default-network-opts": {
    "bridge": {
      "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
    }
  }
}
```

Это страховка на случай забытого префикса, а не замена ему. Явный `127.0.0.1:` в compose читается и через год.

## Почему ufw и nftables не спасают

Опубликованный порт Docker пробрасывает через NAT до того, как пакет дойдёт до цепочки `input`. Документация Docker говорит прямо: Docker и ufw несовместимы, трафик к контейнеру уходит в обход правил ufw. Правило `ufw deny 8080` ничего не закроет. С цепочкой `input` из [гайда по nftables](/gaidy/nftables-minimalnyy-fayrvol/) та же история.

Если порт всё-таки должен быть публичным, но не для всех, фильтруй в цепочке, которую Docker проверяет раньше своих правил.

### Бэкенд iptables (по умолчанию): цепочка DOCKER-USER

`DOCKER-USER` в документации описана как место для пользовательских правил, которые обрабатываются до цепочек `DOCKER-FORWARD` и `DOCKER`. Пример: опубликованные порты доступны только с одного адреса администратора, ответы на исходящие соединения контейнеров не режутся:

```bash
iptables -I DOCKER-USER -i eth0 ! -s 203.0.113.10 -j DROP
iptables -I DOCKER-USER -m state --state RELATED,ESTABLISHED -j ACCEPT
```

`-I` без номера вставляет правило в начало цепочки, поэтому второе правило окажется выше первого. Проверь порядок:

```bash
iptables -L DOCKER-USER -n -v --line-numbers
```

Пакеты в `DOCKER-USER` приходят уже после DNAT, то есть с адресом и портом контейнера. Чтобы сматчить исходный порт на хосте, нужен conntrack:

```bash
iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdst 198.51.100.2 --ctorigdstport 443 -j ACCEPT
```

> [!NOTE]
> Документация Docker предупреждает, что matching через `conntrack` может снижать производительность. На ноде с большим трафиком лучше вообще не публиковать лишнее.

### Бэкенд nftables

В Docker 29 появился экспериментальный бэкенд `"firewall-backend": "nftables"`. В нём **нет** цепочки `DOCKER-USER`. Свои правила кладут в отдельную таблицу с base chain на том же хуке, а таблицы Docker не трогают: он считает их своими и перезапишет правки.

Пример из документации Docker, добавь его в свой конфиг nftables:

```bash
table ip my-table {
  chain my-filter-forward {
    type filter hook forward priority filter; policy accept;
    iifname "eth0" oifname "br-*" ip saddr != 203.0.113.0/24 counter drop
  }
}
```

Вместо `eth0` подставь внешний интерфейс (`ip -br link`).

> [!CAUTION]
> `flush ruleset` удаляет все таблицы nftables, включая таблицы Docker (и бэкенда nftables, и iptables, работающего через nft). После такого сброса делай `systemctl restart docker`, иначе контейнеры останутся без сети.

## Логи json-file: лимит до того, как кончится диск

Драйвер `json-file` по умолчанию не ограничивает размер: `max-size` равен `-1`. Разговорчивый бот пишет в stdout, файл растёт, пока диск не кончится.

Глобальный лимит:

```json {name="/etc/docker/daemon.json"}
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Значения в `log-opts` обязаны быть строками, включая `"3"`. Перед рестартом проверь синтаксис, иначе демон не поднимется:

```bash
dockerd --validate --config-file=/etc/docker/daemon.json
systemctl restart docker
```

> [!IMPORTANT]
> Настройка применяется **только к новым контейнерам**. Существующие продолжат писать без лимита. Compose пересоздаёт контейнер, только если изменился его конфиг или образ, поэтому после правки `daemon.json` нужно явно:
> ```bash
> docker compose up -d --force-recreate
> ```

Лимит можно задать и в самом compose, для конкретного сервиса. Так делают, например, со страницей подписки:

```yaml {name="docker-compose.yml"}
services:
  remnawave-subscription-page:
    logging:
      driver: json-file
      options:
        max-size: "30m"
        max-file: "5"
```

> [!WARNING]
> Не добавляй настройки в `daemon.json` через `tee -a`. Дописанный второй JSON-объект делает файл невалидным, и Docker не стартует. Если там уже есть `registry-mirrors`, объединяй ключи в один объект.

Как найти и срочно ужать уже раздувшийся лог, описано в гайде [«Диск кончился»](/gaidy/mesto-na-diske/).

## MTU в сетях compose

Если у внешнего интерфейса хоста MTU меньше 1500 (туннель, некоторые хостеры), а сеть контейнеров остаётся на 1500, крупные пакеты могут теряться по дороге. В сообществе рабочее значение для сетей бота и панели 1350 ([Docker](/baza/set/docker/), [sysctl, BBR, MTU](/baza/set/sysctl-bbr-mtu/)).

Для пользовательских bridge-сетей MTU задаётся опцией драйвера `com.docker.network.driver.mtu`:

```yaml {name="docker-compose.yml"}
networks:
  bot_network:
    driver: bridge
    driver_opts:
      com.docker.network.driver.mtu: "1350"
```

Ключ `"mtu"` в `daemon.json` действует только на стандартный мост `docker0` и на compose-сети не влияет. Для всех новых bridge-сетей по умолчанию используй `default-network-opts` с тем же ключом `com.docker.network.driver.mtu`.

Узнать MTU хоста: `ip link show eth0`. Опции драйвера задаются при создании сети, у существующей сети их не поменять: сеть нужно пересоздать, например `docker compose down && docker compose up -d` в проекте, который её создаёт.

## External-сети: панель и бот в одной сети

Панель и бот обычно живут в разных compose-проектах. Чтобы бот ходил в панель по `http://remnawave:3000`, оба контейнера должны быть в одной сети. Сеть создаёт один проект (панель), второй подключается к ней как к внешней:

```yaml {name="docker-compose.yml (бот)"}
services:
  bot:
    networks: [remnawave-network]

networks:
  remnawave-network:
    name: remnawave-network
    external: true
```

Что важно знать про `external: true`:

- Compose такую сеть **не создаёт** и падает с ошибкой, если её нет. Сначала поднимай проект-владельца.
- Для внешней сети значимо только поле `name`. `driver`, `ipam`, `driver_opts` игнорируются, поэтому subnet и MTU задаются в проекте, который сеть создаёт.
- Без `name:` Compose добавляет к имени сети префикс проекта. Поэтому сеть бота называется `remnawave-bedolaga-telegram-bot_bot_network`, а не `bot_network` ([Docker в базе](/baza/set/docker/)). Точное имя смотри в `docker network ls`.

`docker network connect remnawave-network remnawave_bot` подключает контейнер на лету, но это временно: при пересоздании контейнера подключение пропадёт. Прописывай сеть в compose.

Внутри контейнера `localhost` означает сам контейнер. Прокси в одной сети с панелью ходит по имени сервиса, а не на `127.0.0.1`.

## Обновление

```bash
cd /opt/remnawave
docker compose pull
docker compose up -d
```

`pull` только скачивает образы. `up -d` пересоздаёт контейнеры, у которых изменился образ или конфиг, тома при этом сохраняются. Для сервисов с `build:` (бот, собираемый из исходников) нужен `docker compose up -d --build`.

> [!TIP]
> Перед обновлением сделай бэкап базы и посмотри релиз: у панели и нод бывают несовместимые версии, и `latest` иногда приходится закреплять на конкретном теге ([установка и обновление](/baza/paneli/ustanovka-obnovlenie/)). Бэкапы — в [гайде по restic](/gaidy/bekapy-restic/).

## Чистка

После каждого обновления старые образы остаются на диске ([ошибки и фиксы](/baza/paneli/oshibki-fiksy/)). Сначала посмотри, что занимает место:

```bash
docker system df
```

Безопасный минимум:

```bash
docker image prune        # только dangling-образы (<none>)
docker builder prune      # кэш сборки
```

> [!CAUTION]
> `docker system prune -a` удаляет все остановленные контейнеры, все сети без контейнеров, **все образы, не используемые контейнерами**, и кэш сборки. Если стек в этот момент остановлен, его контейнеры и образы уйдут. Если остановлена панель, которая создала `remnawave-network`, уйдёт и сеть, и бот с `external: true` перестанет стартовать. `--volumes` дополнительно удаляет анонимные тома. Именованные тома (`postgres_data`) не удаляются без явной команды, но проверять это на проде лучше не стоит.

## Типовые ошибки

**`Pool overlaps with other one on this address space`.** Subnet в compose пересекается с уже существующей сетью. Найди занятые подсети и выбери свободную ([источник](/baza/set/docker/)):

```bash
docker network inspect $(docker network ls -q) -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

**Подсеть Docker совпала с домашней сетью клиента или с сетью хостера.** Среди пулов Docker по умолчанию есть `192.168.0.0/16`. Если это мешает, задай свои пулы в `daemon.json` через `default-address-pools`:

```json {name="/etc/docker/daemon.json"}
{
  "default-address-pools": [
    { "base": "172.17.0.0/16", "size": 24 }
  ]
}
```

**`network ... already exists`.** Сеть с таким именем уже создал другой проект. Объяви её в compose как `external: true` ([ошибки и фиксы](/baza/paneli/oshibki-fiksy/)).

**`Cannot connect to host remnawave:3000` / `host not found`.** Бот или прокси не в той сети, что панель. Проверь `docker network inspect remnawave-network` и допиши сеть в compose.

**Настройки логов не применились.** Контейнер не пересоздавался. `docker compose up -d --force-recreate`.

## Источники

- [Docker: Port publishing and mapping](https://docs.docker.com/engine/network/port-publishing/)
- [Docker: Packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
- [Docker: Docker with iptables (DOCKER-USER)](https://docs.docker.com/engine/network/firewall-iptables/)
- [Docker: Docker with nftables](https://docs.docker.com/engine/network/firewall-nftables/)
- [Docker: Bridge network driver](https://docs.docker.com/engine/network/drivers/bridge/)
- [Docker: JSON File logging driver](https://docs.docker.com/engine/logging/drivers/json-file/)
- [Docker: dockerd reference (daemon.json, --validate, default-network-opts)](https://docs.docker.com/reference/cli/dockerd/)
- [Docker: Networking overview (default-address-pools)](https://docs.docker.com/engine/network/)
- [Compose file reference: networks](https://docs.docker.com/reference/compose-file/networks/)
- [Compose file reference: services (ports, logging)](https://docs.docker.com/reference/compose-file/services/)
- [docker compose up](https://docs.docker.com/reference/cli/docker/compose/up/), [docker compose pull](https://docs.docker.com/reference/cli/docker/compose/pull/)
- [docker system prune](https://docs.docker.com/reference/cli/docker/system/prune/), [docker image prune](https://docs.docker.com/reference/cli/docker/image/prune/), [docker system df](https://docs.docker.com/reference/cli/docker/system/df/), [docker buildx prune](https://docs.docker.com/reference/cli/docker/buildx/prune/)
- [docker network create](https://docs.docker.com/reference/cli/docker/network/create/)
- [iptables(8)](https://man7.org/linux/man-pages/man8/iptables.8.html), [iptables-extensions(8)](https://man7.org/linux/man-pages/man8/iptables-extensions.8.html)
