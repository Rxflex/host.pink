---
title: "MTU и туннели: почему всё виснет на больших пакетах"
lede: "Туннель поднят, пинг идёт, SSH работает, а сайт открывается наполовину и загрузка файла замирает. Почти всегда это MTU: сколько байт съедает туннель, как это должно чиниться само и почему не чинится."
category: net
weight: 6
actual: "Linux 6.x, iputils, iproute2, nftables 1.0+, wireguard-tools 1.0.x; RFC 791, 8200, 768, 9293, 1191, 8201, 2923"
lastmod: 2026-09-24
---

Классическая жалоба: «VPN подключается, Telegram через раз, страницы грузятся до половины». Сеть при этом не лежит: маленькие пакеты проходят, большие молча пропадают. Разбираемся, откуда берутся лишние байты и что с ними делать.

## MTU и MSS

**MTU** (maximum transmission unit) — максимальный размер IP-пакета вместе с заголовками, который интерфейс отправит одним куском. Число 1500 пришло из Ethernet: по RFC 894 поле данных Ethernet-кадра не больше 1500 байт, значит и IP-датаграмма поверх Ethernet не больше 1500. Большинство VPS получают именно его.

**MSS** (maximum segment size): сколько байт *данных* TCP кладёт в один сегмент. Заголовки в MSS не входят. RFC 8200 (раздел 8.3) даёт формулу прямо: для IPv4 MSS = MTU − 40 (20 байт минимального IPv4-заголовка и 20 байт минимального TCP-заголовка), для IPv6 MSS = MTU − 60, потому что заголовок IPv6 на 20 байт длиннее.

| Заголовок | Размер | Где сказано |
|---|---|---|
| IPv4 без опций | 20 байт | RFC 791: минимальное значение IHL равно 5 (5 × 4 байта) |
| IPv6 | 40 байт | RFC 8200 |
| UDP | 8 байт | RFC 768 |
| TCP без опций | 20 байт | RFC 9293 |

{{< stack caption="Обычный TCP-пакет по IPv4 в канале с MTU 1500: на данные остаётся MSS 1460. Размеры по RFC 791 и RFC 9293" unit="байт" >}}
IPv4 | 20
TCP | 20
Данные (MSS) | 1460 | payload
{{< /stack >}}

MSS каждая сторона объявляет в SYN и SYN-ACK. Пока обе стороны сидят на Ethernet с 1500, обе объявят 1460, и ни одна не знает, что где-то посередине есть туннель.

## Сколько съедает WireGuard

Данные в WireGuard идут сообщением типа 4. По спецификации протокола у него 16 байт заголовка: `message_type` (1), `reserved_zero` (3), `receiver_index` (4), `counter` (8). Дальше зашифрованный внутренний пакет, и AEAD на ChaCha20-Poly1305 добавляет к нему 16 байт тега аутентификации (whitepaper: шифротекст длиннее открытого текста на 16 байт, длину тега Poly1305). Итого накладные расходы самого WireGuard 32 байта. Сверху внешние UDP и IP.

- Поверх IPv4: 20 + 8 + 32 = **60 байт**, внутри помещается 1500 − 60 = **1440**.
- Поверх IPv6: 40 + 8 + 32 = **80 байт**, внутри помещается 1500 − 80 = **1420**.

{{< stack caption="WireGuard поверх IPv4 в канале 1500: внутренний пакет до 1440 байт. Формат сообщения из спецификации протокола WireGuard" unit="байт" >}}
IPv4 | 20
UDP | 8
Заголовок WireGuard | 16
Внутренний пакет | 1440 | payload
Тег Poly1305 | 16
{{< /stack >}}

{{< stack caption="WireGuard поверх IPv6 в канале 1500: внутренний пакет до 1420 байт. Это и есть дефолт wg-quick" unit="байт" >}}
IPv6 | 40
UDP | 8
Заголовок WireGuard | 16
Внутренний пакет | 1420 | payload
Тег Poly1305 | 16
{{< /stack >}}

Перед шифрованием WireGuard дополняет внутренний пакет нулями до кратного 16, но whitepaper оговаривает, что это дополнение не должно выводить UDP-пакет за MTU. На расчёт максимума оно не влияет.

### Почему wg-quick ставит 1420

В `wg-quick` (функция `set_mtu_up` в `linux.bash`) логика такая: если `MTU` в конфиге не задан, берётся MTU маршрута до каждого `Endpoint` (или маршрута по умолчанию), выбирается наименьший, и интерфейсу ставится **это число минус 80**. Если определить не удалось, за основу берётся 1500.

80 байт: худший случай из расчёта выше: внешний IPv6. Скрипт заранее не знает, по какому протоколу пойдёт внешний пакет, поэтому вычитает по максимуму, и 1420 подходит для обоих. Поверх IPv4 при этом 20 байт остаются неиспользованными: 1420 + 60 = 1480. Внутри туннеля с MTU 1420 MSS для TCP по IPv4 будет 1380, по IPv6 1360.

> [!NOTE]
> Если внешний канал сам уже меньше 1500 (у хостера туннель, PPPoE и т. п.), вычитать 80 надо из реального MTU пути, а не из 1500. Как его найти, ниже. Настройка туннеля между серверами целиком: гайд [WireGuard между серверами](/gaidy/wireguard-mezhdu-serverami/).

## PMTUD и чёрная дыра

Как система должна узнавать, что путь уже, чем её интерфейс, описано в RFC 1191 (IPv4) и RFC 8201 (IPv6), это Path MTU Discovery:

1. Отправитель ставит в IPv4-заголовке флаг DF (Don't Fragment). В IPv6 его нет: по RFC 8200 фрагментирует только источник, маршрутизаторы никогда.
2. Маршрутизатор, которому пакет не пролезает в следующий линк, выбрасывает его и отвечает ICMP: для IPv4 «Destination Unreachable, fragmentation needed and DF set» (тип 3, код 4 по RFC 792), для IPv6 «Packet Too Big» (RFC 4443). В ответе указан MTU следующего линка.
3. Отправитель уменьшает размер и шлёт заново.

Всё держится на том, что ICMP-ответ дойдёт. RFC 2923 прямо пишет, что файрволы часто настроены глушить весь ICMP, и тогда отправитель так и продолжает слать большие пакеты, которые исчезают в «PMTUD black hole». RFC 8201 повторяет то же для ICMPv6 Packet Too Big.

{{< flow caption="PMTUD ломается: маршрутизатор честно отвечает, но ICMP не доходит до отправителя (RFC 1191, RFC 2923)" >}}
Отправитель
Узкий линк | 1500 байт, DF
!Файрвол | ICMP 3/4
Отправитель ждёт | ICMP выброшен
{{< /flow >}}

### Симптомы

Их описывает сам RFC 2923: пинги и часть интерактивных TCP-соединений работают, а массовая передача ломается на первом большом пакете, соединение висит и в итоге отваливается по таймауту. Маленькие ICMP echo проходят, echo размером в MTU с флагом DF не проходят. Отсюда картина «SSH живой, а `curl` большой страницы висит» и путаница при диагностике: ping-то идёт.

## Диагностика

### ping с запретом фрагментации

`ping -M do` запрещает фрагментацию, в том числе локальную (`ping(8)`). `-s` задаёт число байт *данных*, к которым добавляется 8 байт заголовка ICMP echo (RFC 792) и заголовок IP. Отсюда размеры:

- IPv4: `-s` = MTU − 20 − 8 = MTU − **28**. Для 1500 это 1472.
- IPv6: `-s` = MTU − 40 − 8 = MTU − **48**. Для 1500 это 1452.

```bash
ping -M do -s 1472 -c 3 198.51.100.20      # пакет ровно 1500 по IPv4
ping -6 -M do -s 1452 -c 3 2001:db8::20    # пакет ровно 1500 по IPv6
```

Если не проходит, уменьшай `-s`, пока не пройдёт. Найденный размер плюс 28 (или 48) и есть MTU пути. Если на слишком большой размер пришло сообщение о необходимости фрагментации, PMTUD работает. Если маленькие пинги отвечают, а большие с DF просто пропадают без всякого сообщения, это та самая чёрная дыра.

### tracepath

```bash
tracepath -n 198.51.100.20
```

`tracepath(8)` идёт по маршруту как traceroute, не требует root и показывает Path MTU там, где он меняется (`pmtu 1480`), а в последней строке `Resume: pmtu …` выдаёт итог по всему пути.

### ip link и ss

```bash
ip link show dev wg0          # mtu у интерфейса
ss -ti dst 198.51.100.20      # mss и pmtu у живых TCP-соединений
```

`ss -i` выводит внутреннюю информацию TCP, в том числе `mss:` и `pmtu:` для каждого соединения. Если там 1460 и 1500, а `ping -M do` показал путь уже, значит до ядра не дошёл ни один ICMP об узком месте.

## Лечение

### 1. Правильный MTU на интерфейсе

Для WireGuard: `MTU = <MTU пути − 80>` в `[Interface]` на обеих сторонах. Для любого интерфейса вручную (до перезагрузки):

```bash
ip link set dev wg0 mtu 1380
```

Локальные процессы после этого сами объявят правильный MSS: по RFC 9293 значение в опции MSS равно эффективному MTU минус фиксированные заголовки IP и TCP.

### 2. MSS clamping для транзитного трафика

Если сервер маршрутизирует чужие TCP-соединения (клиенты WireGuard, контейнеры), MSS объявляют клиенты, а они про узкое место на пути сервера ничего не знают. Правильный MSS можно вписать в их SYN по дороге. Синтаксис по вики nftables и `nft(8)`, работает с ядра 4.14 и nftables 0.9:

```bash {name="/etc/nftables.conf"}
table inet mss {
  chain forward {
    type filter hook forward priority mangle; policy accept;
    tcp flags syn tcp option maxseg size set rt mtu
  }
}
```

`rt mtu` в `nft(8)` описан как «TCP maximum segment size of route»: MSS вычисляется из MTU маршрута, в том числе выученного через PMTUD. Это аналог `-j TCPMSS --clamp-mss-to-pmtu` из iptables. Вики отдельно предупреждает: MSS не согласуется, а объявляется каждой стороной отдельно, поэтому менять нужно и исходный SYN, и ответный SYN-ACK. Цепочка `forward` видит оба направления транзитного соединения.

Фиксированное значение тоже допустимо: `tcp option maxseg size set 1380`. Таблица отдельная и с `policy accept`: она только правит SYN и ничего не фильтрует, фильтрацией занимается основной файрвол (гайд [nftables: минимальный файрвол](/gaidy/nftables-minimalnyy-fayrvol/)). Почему две базовые цепочки на одном хуке уживаются, разобрано в гайде [Путь пакета через netfilter](/gaidy/put-paketa-cherez-netfilter/).

> [!IMPORTANT]
> MSS clamping помогает только TCP. UDP (QUIC, Hysteria2, сам WireGuard внутри другого туннеля) он не трогает. Для них остаётся правильный MTU на интерфейсе.

### 3. Не душить ICMP

Самое дешёвое лечение чёрной дыры: не выбрасывать ICMP, на котором держится PMTUD. В [минимальном файрволе](/gaidy/nftables-minimalnyy-fayrvol/) для этого есть `icmp type destination-unreachable` и весь ICMPv6. Если в правилах есть `ip protocol icmp drop` или ICMPv6 режется целиком, это первое, что стоит убрать. На своей стороне включить TCP-зондирование MTU без ICMP (RFC 4821) можно через `net.ipv4.tcp_mtu_probing`: при значении 1 оно включается, когда ядро обнаружило ICMP-чёрную дыру. Настройка разобрана в гайде [sysctl для ноды](/gaidy/sysctl-dlya-nody/).

### 4. MTU Docker-сетей

Контейнеры в bridge-сети получают MTU из опции сети `com.docker.network.driver.mtu`, а не из настроек туннеля на хосте, поэтому при узком внешнем пути её задают явно. Как это сделать в compose и почему ключ `mtu` в `daemon.json` для compose-сетей не работает, в гайде [Docker для панелей и ботов](/gaidy/docker-dlya-paneley/).

## Опыт сообщества

Не норма, а то, что люди находили у себя методом подбора (подробности в базе: [sysctl, BBR, MTU](/baza/set/sysctl-bbr-mtu/), [Docker](/baza/set/docker/), [Hysteria2](/baza/transporty/hysteria2/)):

- Для compose-сетей бота и панели рабочим называют MTU **1350**.
- Telegram работает через раз: советуют пробовать MTU **1380**. В другом случае MTU 1440 на активном интерфейсе вернул к жизни клиентов с мобильного.
- Hysteria2 при MTU 1280 не заводится, при 1420 заводится; минимально рабочим называли 1308. Для сравнения, RFC 9000 запрещает QUIC на путях, которые не пропускают UDP-payload хотя бы в 1200 байт.

Такие числа имеют смысл только вместе с проверкой: `ping -M do` на своём пути покажет, сколько на самом деле пролезает, и подбирать вслепую не придётся.

## Источники

- [RFC 791](https://www.rfc-editor.org/rfc/rfc791): заголовок IPv4, IHL, флаг DF
- [RFC 894](https://www.rfc-editor.org/rfc/rfc894): IP поверх Ethernet, 1500 байт
- [RFC 8200](https://www.rfc-editor.org/rfc/rfc8200): заголовок IPv6, фрагментация только источником, MSS = MTU − 40 / − 60 (раздел 8.3)
- [RFC 768](https://www.rfc-editor.org/rfc/rfc768): заголовок UDP
- [RFC 9293](https://www.rfc-editor.org/rfc/rfc9293): заголовок TCP, опция MSS (раздел 3.7.1)
- [RFC 792](https://www.rfc-editor.org/rfc/rfc792): ICMP echo, код 4 «fragmentation needed and DF set»
- [RFC 4443](https://www.rfc-editor.org/rfc/rfc4443): ICMPv6 Packet Too Big
- [RFC 1191](https://www.rfc-editor.org/rfc/rfc1191), [RFC 8201](https://www.rfc-editor.org/rfc/rfc8201): Path MTU Discovery для IPv4 и IPv6
- [RFC 2923](https://www.rfc-editor.org/rfc/rfc2923): PMTUD black hole, симптомы
- [RFC 4821](https://www.rfc-editor.org/rfc/rfc4821): Packetization Layer PMTUD
- [RFC 9000](https://www.rfc-editor.org/rfc/rfc9000): минимальный размер датаграммы QUIC (раздел 14)
- [WireGuard: Protocol & Cryptography](https://www.wireguard.com/protocol/), [WireGuard whitepaper](https://www.wireguard.com/papers/wireguard.pdf): формат сообщения данных, тег Poly1305, дополнение
- [wireguard-tools: wg-quick/linux.bash](https://github.com/WireGuard/wireguard-tools/blob/master/src/wg-quick/linux.bash): `set_mtu_up`, вычитание 80
- [ping(8)](https://manpages.debian.org/bookworm/iputils-ping/ping.8.en.html), [tracepath(8)](https://manpages.debian.org/bookworm/iputils-tracepath/tracepath.8.en.html), [ip-link(8)](https://manpages.debian.org/bookworm/iproute2/ip-link.8.en.html), [ss(8)](https://manpages.debian.org/bookworm/iproute2/ss.8.en.html)
- [nft(8)](https://manpages.debian.org/trixie/nftables/nft.8.en.html): `tcp option maxseg`, `rt mtu`
- [nftables wiki: Mangling packet headers](https://wiki.nftables.org/wiki-nftables/index.php/Mangling_packet_headers): MSS clamping
- [ip-sysctl.rst](https://docs.kernel.org/networking/ip-sysctl.html): `tcp_mtu_probing`
