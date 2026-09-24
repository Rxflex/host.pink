---
title: "Нода Remnawave: установка и подключение к панели"
lede: "Как панель разговаривает с нодой, откуда берётся SECRET_KEY, как поставить ноду по официальной инструкции и закрыть её порт управления от всех, кроме панели."
category: panels
weight: 2
actual: "Remnawave 3.4.4, Remnawave Node 3.4.1 (по официальному репозиторию на 2026-09-24)"
lastmod: 2026-09-24
---

Установка ноды в документации Remnawave выглядит как «скопируй compose из панели и вставь на сервер». Это правда. Остальное (что внутри этого compose, почему порт ноды нельзя оставлять открытым и что делать, когда нода не выходит в online) документация оставляет на тебя.

> [!NOTE]
> Гайд опирается на панель Remnawave **3.4.4** и ноду **3.4.1** (релизы в [remnawave/backend](https://github.com/remnawave/backend/releases) и [remnawave/node](https://github.com/remnawave/node/releases) на 2026-09-24). Панель предполагается уже установленной: [Remnawave с нуля](/gaidy/remnawave-s-nulya/). Переменные между версиями менялись (по базе сообщества, в 2.3.0 переменные ноды `APP_PORT`/`SSL_CERT` сменились на `NODE_PORT`/`SECRET_KEY`, см. [Релизы](/baza/paneli/relizy/)), так что сверяйся с `.env.sample` и `docker-compose-prod.yml` репозитория ноды.

## Как нода связана с панелью

Панель не содержит Xray-core. Ядро живёт в контейнере `remnanode`, а панель им управляет: отправляет конфигурацию, забирает статистику, перезапускает.

- **Кто кому звонит.** Нода слушает порт `NODE_PORT` и принимает на нём внутренние API-запросы от панели. Больше этот порт ни для чего не используется. Соединение инициирует панель, поэтому на сервере панели для нод ничего открывать не нужно.
- **Как защищено.** По исходникам ноды это HTTPS-сервер с TLS 1.3 и обязательным клиентским сертификатом (`requestCert` + `rejectUnauthorized`), то есть взаимная проверка сертификатов, mTLS.
- **Что такое `SECRET_KEY`.** Упакованный набор из сертификата корневого CA панели, сертификата и ключа ноды, подписанных этим CA, и публичного ключа JWT панели. Нода при старте проверяет набор и печатает в лог рамку `SECRET_KEY OK` или `SECRET_KEY INVALID`.

{{< flow caption="Управление: панель сама подключается к ноде на `NODE_PORT` и передаёт конфигурацию в Xray-core" >}}
Панель
!`remnanode` | mTLS, NODE_PORT
Xray-core | конфиг
{{< /flow >}}

{{< flow caption="Трафик пользователей идёт мимо панели: клиент подключается к инбаунду Xray на ноде" >}}
Клиент
!Xray-core | порт инбаунда
Интернет
{{< /flow >}}

Корневой CA хранится в базе панели (таблица `keygen`). Отсюда два следствия. Дамп базы восстанавливает панель вместе с CA, и старые ноды подключаются как раньше. Потеря базы или команда `Reset certs` в Rescue CLI означает новый `SECRET_KEY` для каждой ноды.

> [!CAUTION]
> Опыт сообщества (июль 2026): все ключи нод одной панели подписаны одним CA, и ротации при повторном использовании нет. Был случай, когда `docker-compose.yml` новой ноды по ошибке запустили на уже работающей, и он заработал ([Установка и обновление](/baza/paneli/ustanovka-obnovlenie/), [Docker-compose](/baza/paneli/docker-compose/)). Compose ноды содержит секрет, храни его как пароль.

## Требования

По документации: Ubuntu или Debian, минимум 1 ядро и 1 ГБ RAM. Сама нода лёгкая, но Xray под нагрузкой может съесть заметно CPU и памяти. Нужен Docker с плагином Compose:

```bash
sudo curl -fsSL https://get.docker.com | sh
```

## Установка

Порядок из документации: сначала нода создаётся в панели, потом compose переносится на сервер.

### 1. Каталог на сервере ноды

```bash
mkdir /opt/remnanode && cd /opt/remnanode
```

### 2. Нода в панели

**Nodes → Management → +**. Основные поля:

| Поле | Что вписать |
|---|---|
| Country | страна сервера |
| Internal name | имя для себя |
| Address | IP или домен ноды |
| Node Port | порт управления, который нода будет слушать для панели |
| Consumption | множитель учёта трафика: `1.0` обычно, `0.5` половина, `2.0` вдвое |

Дальше кнопка **Copy docker-compose.yml**.

### 3. Compose на сервере

```bash
cd /opt/remnanode && nano docker-compose.yml
```

Вставляешь скопированное. По структуре это совпадает с `docker-compose-prod.yml` из репозитория ноды, только с твоими значениями:

```yaml {name="/opt/remnanode/docker-compose.yml"}
services:
  remnanode:
    image: remnawave/node:latest
    container_name: remnanode
    hostname: remnanode
    network_mode: host
    restart: always
    cap_add:
      - NET_ADMIN
    ulimits:
      nofile:
        soft: 1048576
        hard: 1048576
    environment:
      - NODE_PORT=2222
      - SECRET_KEY="сюда панель подставит ключ"
```

- `network_mode: host`: контейнер живёт в сетевом стеке хоста, Xray слушает порты инбаундов прямо на сервере, публиковать их через `ports:` не нужно. Побочный эффект: `NODE_PORT` тоже слушается на всех интерфейсах сервера.
- `cap_add: NET_ADMIN`: в сообществе после 2.7.4 его добавляли вручную при обновлении ([Установка и обновление](/baza/paneli/ustanovka-obnovlenie/)). По релизам, начиная с Node 2.6.0 с этой capability нода сбрасывает соединения пользователя, удалённого из Xray ([Релизы](/baza/paneli/relizy/)). В официальном compose он уже есть.

> [!TIP]
> `latest` удобен, пока панель и ноды обновляются вместе. В сообществе в августе 2026 ловили несовместимость новой ноды со старой панелью и лечили тем, что фиксировали версию образа ([Ошибки → фиксы](/baza/paneli/oshibki-fiksy/)). Теги версий на Docker Hub есть, например `remnawave/node:3.4.1`.

### 4. Запуск

```bash
docker compose up -d && docker compose logs -f -t
```

В логе ищешь рамку `SECRET_KEY OK`. Если там `SECRET_KEY INVALID`, ключ скопирован с обрезанными символами или от другой панели.

### 5. Профиль конфигурации

В карточке создания ноды **Next**, выбираешь **Config Profile**, затем **Create**.

Config Profile в терминах Remnawave это полная конфигурация Xray-core для ноды со всеми инбаундами и общими настройками. На ноду назначается **ровно один** профиль, но в профиле может быть сколько угодно инбаундов, и для каждой ноды можно выбрать, какие из них включить. После ноды нужен хост (Hosts): точка входа, которую увидит клиент в подписке. Сразу после установки панели есть автоматически созданный профиль по умолчанию. Рабочий профиль с VLESS и Reality собирается по гайду [VLESS + Reality](/gaidy/vless-reality/), вариант с XHTTP и своим сайтом-заглушкой в гайде [XHTTP и selfsteal](/gaidy/xhttp-selfsteal/).

## Файрвол

Документация отдельно предупреждает: закрой `NODE_PORT` в файрволе ноды для всех, кроме IP панели.

{{< compare bad="Порт управления открыт всем" good="Только для панели" >}}
```bash
ufw allow 2222
```
Такую строку можно встретить в пошаговых инструкциях из чатов ([Установка и обновление](/baza/paneli/ustanovka-obnovlenie/)). mTLS не пустит чужого, но порт виден сканерам и обнаруживает ноду.
---
```bash
tcp dport 2222 ip saddr $PANEL_IP accept
```
Порт отвечает только панели, остальные пакеты режет политика `drop`.
{{< /compare >}}

За основу бери конфиг из гайда [nftables: минимальный файрвол](/gaidy/nftables-minimalnyy-fayrvol/) и добавь правила ноды в цепочку `input`:

```bash {name="/etc/nftables.conf (фрагмент)"}
define PANEL_IP = 203.0.113.10

table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;
    # ... established, lo, icmp, ssh как в базовом конфиге ...

    # управление нодой: только с IP панели
    tcp dport 2222 ip saddr $PANEL_IP accept

    # порты инбаундов из профиля, например VLESS Reality на 443
    tcp dport 443 accept
  }
}
```

Замени `2222` на свой `NODE_PORT`, а список клиентских портов сверь с инбаундами профиля. Если панель ходит к ноде по IPv6, нужно аналогичное правило с `ip6 saddr`.

Нода работает в `network_mode: host`, поэтому Docker не создаёт для неё правил проброса портов, и цепочка `input` действительно фильтрует её трафик. С контейнерами на `ports:` это не так, подробности в гайде [Docker для панелей и ботов](/gaidy/docker-dlya-paneley/).

> [!NOTE]
> Если прямой связи панель → нода нет (IP панели блокируется по пути, нода за NAT), в сообществе в августе 2026 обсуждали туннель между серверами: WireGuard, NetBird, SOCKS5 ([Установка и обновление](/baza/paneli/ustanovka-obnovlenie/)). Про WireGuard есть гайд [WireGuard между серверами](/gaidy/wireguard-mezhdu-serverami/).

## sysctl

Дефолтное ядро не рассчитано на сотни клиентов. BBR, буферы и лимиты описаны в гайде [sysctl для ноды](/gaidy/sysctl-dlya-nody/).

## Проверка, что нода online

- В **Nodes → Management** статус показывают иконка слева и цвет карточки. У подключённой ноды в карточке видны uptime Xray-core, число подключений, версии Xray и ноды.
- Логи самой ноды:

```bash
cd /opt/remnanode && docker compose logs -f -t
```

- Логи Xray-core внутри контейнера:

```bash
docker exec remnanode xlogs
```

- Конфиг, с которым Xray запущен сейчас (Rescue CLI ноды):

```bash
docker exec -it remnanode cli --dump-config
```

Если `SECRET_KEY` из панели скопировать не получается, его выдаёт Rescue CLI панели: `docker exec -it remnawave cli`, пункт **Get SECRET_KEY for a Remnawave Node**.

### Логи Xray в файл

Официальный рецепт: смонтировать `/var/log/remnanode` в контейнер (`volumes: - '/var/log/remnanode:/var/log/remnanode'`), в профиле указать `"error": "/var/log/remnanode/error.log"` и `"access": "/var/log/remnanode/access.log"`. Документация предупреждает: без ротации логи забьют диск.

```bash {name="/etc/logrotate.d/remnanode"}
/var/log/remnanode/*.log {
      size 50M
      rotate 5
      compress
      missingok
      notifempty
      copytruncate
  }
```

```bash
mkdir -p /var/log/remnanode && logrotate -vf /etc/logrotate.d/remnanode
```

Бэкапить на ноде почти нечего: конфигурация хранится в панели. В сообществе ноду переподнимают за несколько минут, сохраняя только compose и логи ([Установка и обновление](/baza/paneli/ustanovka-obnovlenie/)).

## Обновление

```bash
cd /opt/remnanode && docker compose pull && docker compose down && docker compose up -d && docker compose logs -f
```

Сначала панель, потом ноды. Подробности и откат в гайде [Обновления без поломок](/gaidy/obnovleniya-bez-polomok/).

## Типовые ошибки

| Симптом | Причина и что делать |
|---|---|
| `XML-RPC fault: SPAWN_ERROR: xray` | Xray не стартовал, почти всегда из-за ошибки в конфиге. Причина видна в `docker exec remnanode xlogs`, исправляется в профиле в панели (официальная страница Common errors). |
| `SECRET_KEY INVALID` при старте | Ключ повреждён или не от этой панели. Скопируй заново из карточки ноды или через Rescue CLI панели. |
| Все ноды отвалились разом после работ с панелью | Сброшены сертификаты (`Reset certs`) или панель поднята на пустой базе: CA новый, ключи всех нод надо перевыпустить. |
| `Client network socket disconnected before secure TLS connection was established` | Сообщество, август 2026: новая нода на старой панели 2.8.0. Лечили фиксацией версии ноды в compose ([Ошибки → фиксы](/baza/paneli/oshibki-fiksy/)). |
| `EPROTO` с `alert 40` | Сообщество, август 2026: обновить панель ([Ошибки → фиксы](/baza/paneli/oshibki-fiksy/)). |
| Нода online, но у пользователей её нет | Нет хоста или нода не в скваде пользователя. Сообщество: создать хост, добавить во внутренний сквад, обновить подписку ([индекс ошибок](/baza/indeksy/oshibki/)). |
| Нода не отвечает панели | Проверь с сервера панели, что `NODE_PORT` доступен именно с её IP: правило `ip saddr` с опечаткой или старый IP панели после переезда. |

Остальные случаи с датами в [индексе ошибок](/baza/indeksy/oshibki/) и в разделе [Ошибки → фиксы](/baza/paneli/oshibki-fiksy/).

## Источники

- Remnawave: [Requirements](https://docs.rw/install/requirements), [Remnawave Node](https://docs.rw/install/remnawave-node), [Upgrading](https://docs.rw/install/upgrading)
- Remnawave: [Nodes](https://docs.rw/learn-en/nodes), [Config Profiles](https://docs.rw/learn-en/config-profiles), [Common errors](https://docs.rw/guides/common-errors), [Useful commands](https://docs.rw/guides/useful-commands), [Rescue CLI](https://docs.rw/features/rescue-cli), исходники документации в [remnawave/panel](https://github.com/remnawave/panel/tree/main/docs)
- remnawave/node 3.4.1: [docker-compose-prod.yml](https://github.com/remnawave/node/blob/main/docker-compose-prod.yml), [.env.sample](https://github.com/remnawave/node/blob/main/.env.sample), [main.ts](https://github.com/remnawave/node/blob/main/src/main.ts), [config.schema.ts](https://github.com/remnawave/node/blob/main/src/common/config/app-config/config.schema.ts), [validate-secret-key.util.ts](https://github.com/remnawave/node/blob/main/src/common/utils/decode-node-payload/validate-secret-key.util.ts), [релизы](https://github.com/remnawave/node/releases)
- remnawave/backend 3.4.4: [cli.ts](https://github.com/remnawave/backend/blob/main/src/bin/cli/cli.ts), [schema.prisma](https://github.com/remnawave/backend/blob/main/prisma/schema.prisma)
- Docker Hub: [remnawave/node](https://hub.docker.com/r/remnawave/node/tags)
- Опыт сообщества: [Установка и обновление](/baza/paneli/ustanovka-obnovlenie/), [Docker-compose](/baza/paneli/docker-compose/), [Ошибки → фиксы](/baza/paneli/oshibki-fiksy/), [Релизы](/baza/paneli/relizy/), [Индекс ошибок](/baza/indeksy/oshibki/)
