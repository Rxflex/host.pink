---
title: Витрина компонентов
url: /_kit/
layout: kit
lede: Все кирпичи дизайна на одной странице. Если что-то здесь выглядит криво, криво оно везде.
build:
  list: never
sitemap:
  disable: true
---

## Цвета

Лакмусовая бумага: розовая в кислоте, сливовая ночью.

## Текст

Абзац основного текста. Строка не длиннее семидесяти знаков, чтобы глаз не терял начало следующей. Ссылки [выглядят так](#), а `inline-код` так. Пруф на сообщение выглядит как пилюля с датой [id=322563|Николай|04.04.2026](https://t.me/c/2941121338/322563), первоисточник — [note_055:190-195|30.03.2026](https://github.com/Rxflex/BedolagaBD/blob/main/source/notes/note_055.md#L190).

- МТС режет UDP/QUIC, Hysteria2 не взлетает, бери VLESS [id=320950|~02.04.2026](https://t.me/c/2941121338/320950).
- Воркараунд для tun-клиентов: <kbd>ip rule</kbd> с приоритетом 50.

### Подзаголовок третьего уровня

> Обычная цитата: тихая, с линией слева.

> [!WARNING]
> Не включай `net.ipv4.tcp_tw_recycle`. Его выпилили из ядра в 4.12, а советы в интернете остались.

> [!TIP]
> BBR включается двумя строками в `sysctl.conf`, перезагрузка не нужна.

> [!CAUTION]
> `rm -rf /var/lib/docker` на проде в пятницу вечером.

> [!NOTE]
> Заметка на полях: нейтральная информация.

## Код

```bash
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

```json {name="config.json"}
{"tag": "HYSTERIA", "port": 443, "listen": "0.0.0.0", "protocol": "hysteria",
 "settings": {"clients": [], "version": 2},
 "streamSettings": {"network": "hysteria", "security": "tls", "tlsSettings": {"alpn": ["h3"]}}}
```

```yaml
services:
  remnawave:
    image: remnawave/backend:latest  # не latest в проде
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]
```

## Таблица

| Транспорт | UDP | Живёт в РФ | Пруф |
|---|:-:|---|---|
| VLESS + Reality | нет | местами, зависит от SNI | [id=660505\|09.06.2026](https://t.me/c/2941121338/660505) |
| XHTTP | нет | да, основной рецепт с 11.2025 | [id=869292\|14.07.2026](https://t.me/c/2941121338/869292) |
| Hysteria2 | да | мобильные операторы режут QUIC | [id=306906\|30.03.2026](https://t.me/c/2941121338/306906) |

## Схемы

{{< flow caption="Запрос к панели за Cloudflare" >}}
Браузер
Cloudflare | HTTPS
!nginx | HTTPS, Full (strict)
Панель | HTTP на `127.0.0.1:3000`
{{< /flow >}}

{{< stack caption="Из чего состоит пакет WireGuard в канале с MTU 1500" unit="байт" >}}
IPv4 | 20
UDP | 8
WireGuard | 32
Внутренний пакет | 1440 | payload
{{< /stack >}}

{{< waterfall caption="Запрос к habr.com из Москвы, данные пробы Globalping" unit="мс" >}}
DNS | 0 | 36
TCP | 36 | 2
TLS | 38 | 3
Ожидание ответа | 41 | 62
Загрузка | 103 | 1
{{< /waterfall >}}

{{< bars caption="HTTP до habr.com из разных стран" unit="мс" >}}
!Москва | 29
Санкт-Петербург | 102
Франкфурт | 93
Амстердам | 187
Сингапур | 862
{{< /bars >}}

{{< compare bad="Так порт торчит в мир" good="Так только для прокси" >}}
```yaml
ports:
  - "8080:8080"
```
---
```yaml
ports:
  - "127.0.0.1:8080:8080"
```
{{< /compare >}}
