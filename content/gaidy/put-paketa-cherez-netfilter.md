---
title: "Путь пакета через netfilter: где сработает твоё правило"
lede: "Правило есть, а трафик идёт мимо. Или правило разрешает, а пакет всё равно пропадает. Разбираем, через какие хуки проходит пакет, где работают conntrack и NAT и почему Docker обходит цепочку input."
category: net
weight: 7
actual: "Linux 6.x, nftables 1.0+, iptables-nft 1.8+, Docker Engine 28+"
lastmod: 2026-09-24
---

«Я же закрыл порт» — самая частая фраза перед тем, как выясняется, что порт открыт. Файрвол при этом работает честно: правило просто стоит не на том пути, по которому идёт пакет.

## Пять хуков

nftables работает поверх той же инфраструктуры netfilter, что и iptables: хуки, conntrack и NAT общие, новый только движок правил. Хук: точка в сетевом стеке ядра, к которой прикрепляется базовая цепочка (`type … hook … priority …`). По вики nftables:

| Хук | Что видит |
|---|---|
| `prerouting` | все входящие пакеты до решения о маршруте, и локальные, и транзитные |
| `input` | входящие пакеты, которые маршрутизированы на эту машину, её процессам |
| `forward` | входящие пакеты, адресованные не этой машине |
| `output` | пакеты, созданные локальными процессами |
| `postrouting` | все пакеты после маршрутизации, перед уходом с машины |

Есть ещё `ingress` (привязан к конкретному интерфейсу, раньше `prerouting`), но для VPS-файрвола он обычно не нужен. В отличие от iptables, nftables не создаёт цепочек сам: хук, для которого ты не завёл базовую цепочку, ничего не фильтрует.

## Три пути

Какие хуки пройдёт пакет, решает маршрутизация после `prerouting`: адрес назначения свой или чужой.

{{< flow caption="Пакет к локальному процессу: `prerouting` (conntrack, DNAT), решение о маршруте, `input`. По вики nftables, Netfilter hooks" >}}
Сеть
`prerouting` | вход
Решение о маршруте | после DNAT
!`input` | адрес свой
Процесс | accept
{{< /flow >}}

{{< flow caption="Транзитный пакет: `prerouting`, `forward`, `postrouting` (здесь SNAT). Нужен включённый `ip_forward`" >}}
Сеть
`prerouting` | вход
Решение о маршруте | после DNAT
!`forward` | адрес чужой
`postrouting` | accept
Сеть | после SNAT
{{< /flow >}}

{{< flow caption="Пакет от локального процесса: `output` (здесь тоже работает conntrack), затем `postrouting`" >}}
Процесс
!`output` | новый пакет
`postrouting` | accept
Сеть | после SNAT
{{< /flow >}}

Главное следствие: **транзитный пакет не проходит `input`**, а локальный не проходит `forward`. Правило, поставленное не в ту цепочку, для пакета просто не существует.

## Приоритеты: порядок внутри хука

На одном хуке может висеть несколько базовых цепочек и внутренние операции ядра. Выполняются они по возрастанию числа `priority`. Стандартные имена из `nft(8)` и вики:

| Имя | Значение | Где | Что там происходит |
|---|---|---|---|
| `raw` | −300 | все | до conntrack |
| без имени | −200 | prerouting, output | conntrack сопоставляет пакет с соединением |
| `mangle` | −150 | все | изменение пакетов |
| `dstnat` | −100 | prerouting | DNAT |
| `filter` | 0 | все | обычная фильтрация |
| `srcnat` | 100 | postrouting | SNAT, masquerade |

Отсюда порядок в `prerouting`: сначала conntrack (−200), потом DNAT (−100), потом фильтр (0). Когда пакет доходит до фильтрующих цепочек, у него уже может быть другой адрес назначения. Новое соединение conntrack окончательно записывает в таблицу в самом конце хуков `input` и `postrouting`.

Цепочки типа `nat` видят только первый пакет соединения, остальные пакеты того же потока conntrack транслирует сам и мимо них. Поэтому вики прямо запрещает фильтровать в nat-цепочках.

## Почему Docker обходит input

Опубликованный порт (`ports: "8080:80"`) Docker реализует через DNAT: адрес назначения меняется с адреса хоста на адрес контейнера. Документация Docker так и пишет: трафик контейнеров уходит в сторону в таблице `nat`, до цепочек `INPUT` и `OUTPUT`, которыми пользуется ufw, и правила ufw для него фактически не действуют.

Если сложить с таблицей выше: DNAT срабатывает в `prerouting`, решение о маршруте принимается уже по адресу контейнера, этот адрес машине не принадлежит (он за мостом `docker0`/`br-*`), и пакет идёт в **`forward`**. Цепочка `input` его не видит совсем.

{{< compare bad="Правило в input: порт всё равно открыт" good="Правило в forward: работает" >}}
```bash
chain input {
  type filter hook input priority filter;
  policy drop;
  # до сюда пакет на опубликованный
  # порт не доходит: после DNAT
  # он транзитный
  tcp dport 8080 drop
}
```
---
```bash
table ip my-table {
  chain my-filter-forward {
    type filter hook forward priority filter;
    policy accept;
    iifname "eth0" oifname "br-*" ip saddr != 203.0.113.10 counter drop
  }
}
```
{{< /compare >}}

Правая колонка повторяет пример из документации Docker для бэкенда nftables. С бэкендом iptables то же место называется цепочкой `DOCKER-USER`: Docker прыгает в неё из `FORWARD` раньше своих правил. В обоих случаях пакет приходит уже после DNAT, то есть с адресом и портом **контейнера**. Чтобы сматчить исходный порт хоста, смотрят в conntrack: в iptables через `-m conntrack --ctorigdstport`, в nftables выражением `ct original proto-dst`.

Проще всего вообще не доводить до этого: публиковать порт на `127.0.0.1`. Разбор и примеры в гайде [Docker для панелей и ботов](/gaidy/docker-dlya-paneley/).

## accept не финальный

По `nft(8)` и вики nftables:

- `drop` окончательный: пакет выброшен сразу, дальше не проверяется ни одна цепочка.
- `accept` завершает только **текущую** базовую цепочку. Если на том же хуке есть ещё одна базовая цепочка с большим числом `priority`, пакет пойдёт и в неё, и она может его выбросить. Политика цепочки `policy accept` ведёт себя так же.

Вики приводит пример: цепочка `services` на `input` с приоритетом 0 делает `tcp dport ssh accept`, а вторая цепочка на `input` с приоритетом 1 и `policy drop` выбрасывает всё. SSH не работает.

На сервере с Docker это проявляется так. Если `iptables` в системе работает через nf_tables (`iptables -V` покажет `(nf_tables)`), правила Docker лежат в таблице `ip filter`, в цепочке `FORWARD` на хуке `forward` с приоритетом 0; `xtables-nft(8)` показывает, что такие таблицы видны в `nft list ruleset`. Если в твоём `/etc/nftables.conf` есть своя цепочка `forward` с `policy drop`, пакет, разрешённый Docker, дойдёт до неё и будет выброшен: контейнеры теряют сеть. Документация Docker про бэкенд nftables говорит то же: `accept` в одной базовой цепочке не мешает другой базовой цепочке пакет выбросить, и переопределить `drop` Docker через свой `accept` нельзя, для этого есть опция `--bridge-accept-fwmark`.

> [!WARNING]
> Обратное тоже верно: `drop` в твоей цепочке на `forward` сработает независимо от того, что разрешил Docker. На этом и держится пример из правой колонки выше. Поэтому на сервере с Docker своя `forward`-цепочка должна быть с `policy accept` и точечными `drop`, как объяснено в гайде [nftables: минимальный файрвол](/gaidy/nftables-minimalnyy-fayrvol/).

## Как посмотреть, что происходит

### Весь набор правил

```bash
nft list ruleset
```

Выводит все таблицы всех семейств, включая созданные Docker и iptables-nft. Первое, на что смотреть: сколько базовых цепочек висит на нужном хуке и с какими приоритетами. `nft -a list ruleset` добавляет номера `handle`, по ним удаляют и вставляют правила.

### Счётчики

`counter` считает пакеты и байты, которые дошли до этого места в правиле. Выражения внутри правила проверяются слева направо, поэтому положение имеет значение: `ip protocol tcp counter` считает только TCP, а `counter ip protocol tcp` считает всё.

```bash
nft add rule inet filter input tcp dport 8080 counter
nft list chain inet filter input
```

Если счётчик правила в `input` стоит на нуле, пока снаружи ломятся на 8080, пакеты до `input` не доходят. Для опубликованного порта Docker ищи их в `forward`.

### Трассировка

`nft monitor trace` показывает путь конкретного пакета: в какие цепочки он вошёл, какое правило сработало и с каким вердиктом. Работает с ядра 4.6 и nftables 0.6. Метку трассировки ставит правило `meta nftrace set 1`, и вики советует делать это в отдельной цепочке, которая стоит раньше остальных:

```bash
nft add table inet trace
nft add chain inet trace pre '{ type filter hook prerouting priority -301; }'
nft add rule inet trace pre tcp dport 8080 meta nftrace set 1
nft monitor trace
```

Приоритет −301 ставит цепочку перед `raw` (−300), conntrack и NAT, так что метку пакет получает раньше, чем с ним что-то сделают твои правила или правила Docker. Условие `tcp dport 8080` важно: без него трассировка захлестнёт терминал. Каждый пакет получает `trace id`, по нему удобно следить за одним пакетом через все цепочки. Закончив, убери за собой:

```bash
nft delete table inet trace
```

> [!NOTE]
> Правила, добавленные через `iptables-nft` (в том числе правила Docker), по `xtables-nft(8)` трассируются через `-j TRACE` и `xtables-monitor --trace`.

## Шпаргалка

| Хочу | Куда ставить |
|---|---|
| закрыть порт процесса на хосте (sshd, nginx, Xray без Docker) | `input` |
| закрыть или ограничить опубликованный порт контейнера | `forward` (своя таблица) или `DOCKER-USER` при бэкенде iptables |
| фильтровать клиентов WireGuard, выходящих в интернет | `forward` |
| NAT для клиентов туннеля | `postrouting`, `type nat`, `priority srcnat` |
| пробросить порт | `prerouting`, `type nat`, `priority dstnat` |
| поменять MSS в SYN | `forward`, см. гайд [MTU и туннели](/gaidy/mtu-i-tunneli/) |

Готовые наборы правил из практики сообщества (iptables, hashlimit, ipset, XDP, fail2ban) собраны в базе: [Файрвол и DDoS](/baza/set/firewall-ddos/). Прежде чем копировать, определи по этому гайду, на каком хуке они сработают на твоём сервере.

## Источники

- [nftables wiki: Netfilter hooks](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks): пути пакета, хуки по семействам, приоритеты conntrack и NAT
- [nftables wiki: Configuring chains](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains): описание хуков, порядок по приоритету, «accept не финальный», nat видит только первый пакет
- [nftables wiki: Ruleset debug/tracing](https://wiki.nftables.org/wiki-nftables/index.php/Ruleset_debug/tracing): `meta nftrace set 1`, `nft monitor trace`
- [nftables wiki: Counters](https://wiki.nftables.org/wiki-nftables/index.php/Counters)
- [nft(8)](https://manpages.debian.org/trixie/nftables/nft.8.en.html): стандартные имена приоритетов, вердикты `accept`/`drop`, `ct original proto-dst`, `monitor`
- [xtables-nft(8)](https://manpages.debian.org/bookworm/iptables/xtables-nft.8.en.html): iptables-nft поверх nf_tables, трассировка через `xtables-monitor`
- [Docker: Packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/): Docker и ufw, DNAT до INPUT
- [Docker: Docker with iptables](https://docs.docker.com/engine/network/firewall-iptables/): `DOCKER-USER`, пакеты после DNAT, `--ctorigdstport`
- [Docker: Docker with nftables](https://docs.docker.com/engine/network/firewall-nftables/): своя таблица вместо `DOCKER-USER`, «accept is not final», `--bridge-accept-fwmark`
