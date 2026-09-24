---
title: "nftables: минимальный файрвол для VPS"
lede: "Закрыть всё лишнее, оставить SSH и сервисы, притормозить перебор паролей. Без ufw, без iptables-legacy и без блокировки самого себя."
category: server
weight: 3
actual: "nftables 1.0+, Debian 12 / Ubuntu 24.04"
lastmod: 2026-09-24
---

Голый VPS в интернете начинают сканировать через минуты после запуска. Файрвол не делает сервер неуязвимым, но убирает очевидное: торчащие наружу базы, панели и отладочные порты, про которые ты забыл.

## Сначала страховка

Главная ошибка с файрволом — применить правила и потерять SSH. Поэтому перед применением ставим таймер, который через две минуты всё откатит. `nohup` нужен, чтобы таймер не умер вместе с сессией: при обрыве SSH shell рассылает своим фоновым задачам SIGHUP.

```bash
nohup sh -c 'sleep 120 && nft flush ruleset' >/dev/null 2>&1 &
```

Применил правила, зашёл новым SSH-соединением, всё работает — убиваем таймер из той же сессии:

```bash
kill %1
```

Не зашёл — ждёшь две минуты, правила слетают сами.

## Конфиг

```bash {name="/etc/nftables.conf"}
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  # счётчик частоты новых SSH-подключений на каждый адрес источника
  set ssh_flood4 { type ipv4_addr; flags dynamic; timeout 10m; size 65536; }
  set ssh_flood6 { type ipv6_addr; flags dynamic; timeout 10m; size 65536; }

  chain input {
    type filter hook input priority filter; policy drop;

    ct state established,related accept
    ct state invalid drop
    iif "lo" accept

    # ICMP нужен для MTU и диагностики, но без флуда
    ip protocol icmp icmp type { echo-request, destination-unreachable, time-exceeded } limit rate 20/second accept
    # без ICMPv6 IPv6 просто не работает: соседи, MTU, SLAAC.
    # meta l4proto, а не ip6 nexthdr: MLD приходит с hop-by-hop заголовком,
    # и nexthdr там не icmpv6
    meta l4proto ipv6-icmp accept

    # SSH с ограничением частоты новых подключений
    tcp dport 22 ct state new add @ssh_flood4 { ip saddr limit rate over 10/minute } drop
    tcp dport 22 ct state new add @ssh_flood6 { ip6 saddr limit rate over 10/minute } drop
    tcp dport 22 accept

    # веб и прокси
    tcp dport { 80, 443 } accept
    udp dport 443 accept   # HTTP/3, Hysteria2

    counter comment "отброшено политикой"
  }

  chain forward {
    type filter hook forward priority filter; policy drop;
  }

  chain output {
    type filter hook output priority filter; policy accept;
  }
}
```

Проверить синтаксис, ничего не применяя:

```bash
nft -c -f /etc/nftables.conf
```

Применить и включить при загрузке:

```bash
nft -f /etc/nftables.conf && systemctl enable nftables
```

## Если на сервере Docker

> [!WARNING]
> `flush ruleset` сносит все таблицы, включая правила Docker (с iptables-nft они живут в тех же nftables). После применения конфига сделай `systemctl restart docker`, чтобы он создал их заново, иначе контейнеры потеряют сеть. И помни: трафик на порты, опубликованные через `ports:` в compose, Docker перенаправляет в таблице `nat` ещё до цепочки `input`, так что она его не видит.

Чтобы база или панель в контейнере не торчала в интернет, публикуй её только на localhost:

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

Цепочка `forward` с `policy drop` выше подходит для сервера без Docker и без маршрутизации. С Docker её нужно удалить (или поставить `policy accept`), а не просто оставить пустой. В nftables `accept` в одной базовой цепочке не финальный: пакет проходит и остальные базовые цепочки на том же хуке, и `drop` в твоей таблице выбросит трафик контейнеров, даже если Docker его разрешил.

## Посмотреть, что происходит

```bash
nft list ruleset          # что сейчас загружено
nft list set inet filter ssh_flood4   # адреса, которые недавно открывали SSH, с их лимитерами
```

Счётчик в конце цепочки `input` покажет, сколько мусора отбрасывается. Обычно цифра впечатляет уже через час.

## Дальше

- Для защиты SSH одного файрвола мало. Ключи вместо паролей, отключённый root по паролю и прочее — в гайде [SSH без боли](/gaidy/ssh-bez-boli/).
- Hashlimit, ipset, XDP и анти-DDoS-схемы, которые реально использует сообщество: [Firewall и анти-DDoS](/baza/set/firewall-ddos/).
- Проверить, какие порты видит мир: [досье своего IP](/ip), карточка «Открытые порты и сервисы». Это данные Shodan InternetDB, они обновляются раз в неделю, так что свежие изменения там появятся не сразу.

## Источники

- [nft(8)](https://manpages.debian.org/bookworm/nftables/nft.8.en.html): `-c`/`--check`, `-f`, `flush ruleset`, флаги множеств (`dynamic`, `timeout`, `size`), set statement `add @set { ip saddr limit rate over ... }`
- nftables wiki: [Meters](https://wiki.nftables.org/wiki-nftables/index.php/Meters) (dynamic set + limit), [Matching packet headers](https://wiki.nftables.org/wiki-nftables/index.php/Matching_packet_headers) (`ip6 nexthdr` против `meta l4proto`), [Simple ruleset for a server](https://wiki.nftables.org/wiki-nftables/index.php/Simple_ruleset_for_a_server)
- [bash(1)](https://man7.org/linux/man-pages/man1/bash.1.html): SIGHUP фоновым задачам при выходе shell; [nohup(1)](https://man7.org/linux/man-pages/man1/nohup.1.html)
- Docker: [Packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/), [Docker with nftables](https://docs.docker.com/engine/network/firewall-nftables/) (accept не финальный между базовыми цепочками), [Port publishing](https://docs.docker.com/engine/network/port-publishing/) (публикация на `127.0.0.1`)
- [Shodan InternetDB](https://internetdb.shodan.io/): обновление раз в неделю
