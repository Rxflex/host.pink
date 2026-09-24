---
title: "sysctl для ноды: BBR, буферы и очереди"
lede: "Один файл, который превращает дефолтное ядро в ноду, способную переварить трафик. С объяснением, что каждая строка делает."
category: server
weight: 4
actual: "Ubuntu 24.04 / Debian 12, ядро 6.x"
lastmod: 2026-09-24
---

Дефолтные настройки ядра рассчитаны на ноутбук, а не на ноду, через которую ходят сотни клиентов. Хорошая новость: чинится одним файлом и одной командой. Плохая: половина советов в интернете копируется с 2014 года и либо бесполезна, либо вредна.

## Проверь, что BBR вообще есть

BBR живёт в ядре начиная с 4.9. В любом современном дистрибутиве он есть, но модуль может быть не загружен:

```bash
sysctl net.ipv4.tcp_available_congestion_control
```

Если в списке нет `bbr`:

```bash
modprobe tcp_bbr && echo tcp_bbr > /etc/modules-load.d/bbr.conf
```

## Файл целиком

Кладём в отдельный файл, а не в `/etc/sysctl.conf`, чтобы обновления пакетов его не трогали:

```ini {name="/etc/sysctl.d/99-node.conf"}
# Очередь fq + BBR: меньше задержка, выше скорость на плохих каналах
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# Буферы сокетов до 64 МБ: нужно для гигабита на дальних маршрутах
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
# min / default / max: первые два числа — дефолты ядра, поднимаем только max
net.ipv4.tcp_rmem = 4096 131072 67108864
net.ipv4.tcp_wmem = 4096 16384 67108864

# Очереди соединений: чтобы всплеск клиентов не упирался в дефолтный somaxconn = 4096
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 250000

# Больше исходящих портов (дефолт 32768–60999) и переиспользование TIME-WAIT
# для исходящих соединений (дефолт tcp_tw_reuse = 2 — только для loopback)
net.ipv4.ip_local_port_range = 10000 65535
net.ipv4.tcp_tw_reuse = 1
# сколько осиротевшее соединение висит в FIN_WAIT_2 (дефолт 60 с)
net.ipv4.tcp_fin_timeout = 15

# Не сбрасывать окно после простоя (дефолт 1 — сбрасывать)
net.ipv4.tcp_slow_start_after_idle = 0
# Искать рабочий MTU сам, когда обнаружена ICMP-чёрная дыра (дефолт 0 — выключено)
net.ipv4.tcp_mtu_probing = 1
# TCP Fast Open для клиента и сервера (дефолт 1 — только клиент).
# Серверная часть работает, только если приложение включает TFO на своём сокете
net.ipv4.tcp_fastopen = 3

# Файловые дескрипторы: каждое соединение — это файл.
# file-max — на всю систему, nr_open — потолок на процесс (дефолт 1048576)
fs.file-max = 2097152
fs.nr_open = 2097152
```

Применяем без перезагрузки:

```bash
sysctl --system
```

И проверяем, что BBR взлетел:

```bash
sysctl net.ipv4.tcp_congestion_control net.core.default_qdisc
```

## Лимиты процессов

`fs.file-max` — это потолок на всю систему. У процесса свой лимит `RLIMIT_NOFILE`, и под systemd он по умолчанию `1024:524288`: мягкий 1024, жёсткий 524288. Программа, которая сама не поднимает мягкий лимит, упрётся в `too many open files` примерно на тысяче соединений.

Xray и другие программы на Go (с Go 1.19) сами поднимают мягкий лимит до жёсткого, а юнит из официального установщика XTLS/Xray-install уже содержит `LimitNOFILE=1000000`. Свой лимит нужен, если сервис запускается своим юнитом или это не Go-программа. Для сервисов под systemd:

```ini {name="/etc/systemd/system/xray.service.d/limits.conf"}
[Service]
LimitNOFILE=1048576
```

```bash
systemctl daemon-reload && systemctl restart xray
```

Для Docker лимит задаётся в compose через `ulimits`: одним числом (`nofile: 1048576`) или парой `soft`/`hard`. `LimitNOFILE` не может быть больше `fs.nr_open`.

## Conntrack

Если на ноде есть NAT, Docker или iptables с `ct state`, ядро помнит каждое соединение в таблице conntrack. Переполнится — новые соединения начнут молча отваливаться, а в `dmesg` появится `nf_conntrack: table full, dropping packet`.

```ini {name="/etc/sysctl.d/99-conntrack.conf"}
# дефолт равен nf_conntrack_buckets и зависит от объёма памяти
net.netfilter.nf_conntrack_max = 1048576
# дефолт 432000 (5 суток): мёртвые established-записи долго занимают таблицу
net.netfilter.nf_conntrack_tcp_timeout_established = 7200
```

> [!NOTE]
> Параметры `nf_conntrack` появляются, только когда модуль загружен. Если `sysctl --system` ругается на них при загрузке, добавь `nf_conntrack` в `/etc/modules-load.d/`.

## Чего не делать

> [!CAUTION]
> `net.ipv4.tcp_tw_recycle = 1`. Этот параметр ломал клиентов за NAT и был удалён из ядра в 4.12. На современном ядре такого ключа просто нет, и `sysctl` ругается на него. Если он есть в твоём «оптимизационном скрипте», скрипт писали очень давно.

- **Не раздувай `rmem_default`/`wmem_default` и `tcp_mem`.** `rmem_default` и `wmem_default` — стартовый буфер каждого сокета, и тысяча клиентов умножит его на тысячу. `tcp_mem` — общий лимит памяти TCP в страницах (не в байтах): ядро считает его при загрузке от объёма RAM, и если его задрать, TCP перестанет себя ограничивать, пока память не кончится.
- **Не отключай IPv6 через sysctl «на всякий случай».** Часть софта ожидает `::1` и потом ломается загадочно. Если IPv6 не нужен, просто не слушай на нём.
- **Не копируй наборы целиком, не читая.** Сравнить с тем, что используют в сообществе, можно в базе: [sysctl, BBR, MTU](/baza/set/sysctl-bbr-mtu/).

## Проверка до и после

Разницу видно на дальних маршрутах. Прогони `iperf3` до сервера в другой стране до и после применения:

```bash
iperf3 -c <сервер> -t 20 -P 4
```

Если скорость не изменилась, узкое место не в ядре: смотри на канал хостера и CPU steal. Как это проверить — в [чек-листе нового VPS](/gaidy/proverka-novogo-vps/).

## Источники

- [ip-sysctl.rst](https://docs.kernel.org/networking/ip-sysctl.html): `tcp_congestion_control`, `tcp_available_congestion_control`, `tcp_rmem`, `tcp_wmem`, `tcp_mem`, `somaxconn`, `tcp_max_syn_backlog`, `ip_local_port_range`, `tcp_tw_reuse`, `tcp_fin_timeout`, `tcp_slow_start_after_idle`, `tcp_mtu_probing`, `tcp_fastopen`
- [sysctl/net.rst](https://docs.kernel.org/admin-guide/sysctl/net.html): `default_qdisc`, `rmem_max`, `wmem_max`, `rmem_default`, `wmem_default`, `netdev_max_backlog`
- [sysctl/fs.rst](https://docs.kernel.org/admin-guide/sysctl/fs.html): `file-max`, `nr_open`
- [nf_conntrack-sysctl.rst](https://docs.kernel.org/networking/nf_conntrack-sysctl.html): `nf_conntrack_max`, `nf_conntrack_buckets`, `nf_conntrack_tcp_timeout_established`
- [Linux 4.9 (kernelnewbies)](https://kernelnewbies.org/Linux_4.9): BBR; [Linux 4.12 (kernelnewbies)](https://kernelnewbies.org/Linux_4.12) и [коммит «tcp: remove tcp_tw_recycle»](https://git.kernel.org/linus/4396e46187ca5070219b81773c4e65088dac50cc)
- [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html): `LimitNOFILE=`; [systemd-system.conf(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd-system.conf.html): `DefaultLimitNOFILE=1024:524288`
- [Go 1.19 release notes](https://go.dev/doc/go1.19): автоматический подъём `RLIMIT_NOFILE`; [XTLS/Xray-install](https://github.com/XTLS/Xray-install): `LimitNOFILE=1000000` в юните
- [Compose file reference: ulimits](https://docs.docker.com/reference/compose-file/services/#ulimits)
- [iperf3(1)](https://manpages.debian.org/bookworm/iperf3/iperf3.1.en.html): `-c`, `-t`, `-P`
