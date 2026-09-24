---
title: "DNS: что происходит между запросом и ответом"
lede: "Кто на самом деле отвечает на запрос, сколько живёт кэш, какие записи важны админу, что даёт DNSSEC и зачем DoH/DoT. С командами и реальными замерами."
category: net
weight: 4
actual: "RFC 1034/1035, 2181, 2308, 4033–4035, 7858, 8484, 9460, 9499, 9989; dig из BIND 9 (Debian trixie); замеры 2026-09-23"
lastmod: 2026-09-24
---

«Это DNS» говорят про любую непонятную поломку, и в половине случаев угадывают. Разберём, из каких звеньев состоит ответ, чтобы понимать, какое из них сломалось.

## Кто участвует

Термины из RFC 9499:

- **Stub resolver** — резолвер, который сам разрешать имена не умеет и просит об этом рекурсивный. Это libc, `systemd-resolved`, резолвер в браузере или в Xray.
- **Рекурсивный резолвер** — принимает запрос с флагом RD (recursion desired), сам обходит дерево DNS и, как правило, кэширует ответы. Это DNS провайдера, хостера, 1.1.1.1, 8.8.8.8.
- **Авторитетный сервер** — хранит зону и отвечает за неё. Для example.com сейчас это `hera.ns.cloudflare.com` и `elliott.ns.cloudflare.com`.

{{< flow caption="Путь запроса `example.com A` при пустом кэше резолвера. Root и .com отвечают не адресом, а направлением (referral) к следующему серверу." >}}
Stub resolver
!Рекурсивный резолвер | RD=1
Root | referral
TLD .com | referral
Авторитетный NS | ответ
{{< /flow >}}

Корневых имён 13 (от a до m.root-servers.net), их держат 12 независимых организаций. По данным root-servers.org на 2026-09-23, за этими именами стоит 2045 работающих экземпляров по всему миру. Ответы корня и TLD тоже кэшируются по TTL, поэтому полный проход от корня резолвер делает только для того, чего нет в кэше.

## Кэш и TTL

**TTL** — время в секундах, в течение которого запись можно держать в кэше, прежде чем снова спрашивать источник (RFC 1035). Это беззнаковое число от 0 до 2147483647 (RFC 2181). Резолвер отдаёт из кэша остаток TTL, а не исходное значение. Реальный пример, 2026-09-23 22:26 UTC:

| Резолвер | Ответ на `example.com A` | TTL |
|---|---|---|
| 1.1.1.1 (DoH) | 172.66.147.243, 104.20.23.154 | 48 |
| dns.google (JSON API) | 172.66.147.243, 104.20.23.154 | 300 |

Исходный TTL виден в подписи DNSSEC: в RRSIG из ответа 1.1.1.1 поле Original TTL равно 300. Значит, в кэше 1.1.1.1 запись лежала уже 252 секунды. У каждого резолвера свой кэш, поэтому два резолвера в одну и ту же секунду показывают разный TTL.

> [!IMPORTANT]
> Практический вывод: если собираешься сменить IP сервера, снизь TTL записи заранее, минимум за время старого TTL. Иначе резолверы будут отдавать старый адрес, пока не истечёт то, что они уже закэшировали.

**Отрицательный кэш.** «Такого имени нет» (NXDOMAIN) и «имя есть, записи такого типа нет» (NODATA) тоже кэшируются. Авторитетный сервер кладёт в ответ SOA зоны, и срок жизни отрицательного ответа равен меньшему из двух значений: поле MINIMUM в SOA и TTL самой SOA (RFC 2308). У example.com MINIMUM равен 1800, то есть «нет такого поддомена» может жить в кэше до 30 минут. Классика: проверил `cabinet.example.com` до того, как создал запись, получил NXDOMAIN, создал запись, а резолвер продолжает говорить, что её нет.

## Записи, которые нужны админу

| Тип | Зачем | На что наступают |
|---|---|---|
| **A / AAAA** | IPv4 / IPv6 адрес | AAAA указывает на адрес, где сервис не слушает: по IPv6 до него не достучаться |
| **CNAME** | Имя-псевдоним другого имени | На узле с CNAME не должно быть других данных (RFC 1034), поэтому на корне зоны, где лежат SOA и NS, CNAME не ставят |
| **MX** | Куда слать почту для домена | Имя в MX не должно быть псевдонимом (RFC 2181, 10.3) |
| **NS** | Какие серверы авторитетны для зоны | То же правило: не псевдоним |
| **TXT** | Произвольный текст | Здесь живут SPF, DKIM, DMARC и проверки владения доменом |
| **CAA** | Какие УЦ могут выпускать сертификаты для домена | УЦ обязан проверить CAA перед выпуском (RFC 8659). Теги `issue`, `issuewild`, `iodef` |
| **HTTPS** | Параметры подключения: ALPN (например, h2/h3), ключи ECH, подсказки адресов | Позволяет сделать псевдоним на корне зоны, где CNAME нельзя (RFC 9460) |

### SPF, DKIM, DMARC в трёх строках

- **SPF** (RFC 7208): TXT на домене, начинается с `v=spf1`, перечисляет, кто может отправлять почту от имени домена. Механизмы `include`, `a`, `mx`, `ptr`, `exists` и модификатор `redirect` вместе не должны давать больше 10 DNS-запросов, иначе результат `permerror`.
- **DKIM** (RFC 6376): публичный ключ лежит в TXT по адресу `<селектор>._domainkey.<домен>`, почтовый сервер подписывает письма закрытым.
- **DMARC**: TXT на `_dmarc.<домен>` с политикой `p=none`, `quarantine` или `reject`. С мая 2026 года DMARC описан в RFC 9989 (стандарт), он заменил информационный RFC 7489. Тег `pct` в новой версии убран.

## DNSSEC

DNSSEC даёт проверку происхождения и целостности данных DNS и **не даёт конфиденциальности** (RFC 4033). Подписывается не весь ответ, а каждый набор записей одного типа (RRset): рядом лежит запись RRSIG. Публичные ключи зоны лежат в DNSKEY, а родительская зона подтверждает их записью DS. Так строится цепочка от корня до твоей зоны.

- Валидирующий резолвер при успешной проверке ставит в ответе флаг **AD** (authenticated data). Если подпись не сошлась (статус bogus), клиент получает SERVFAIL.
- Stub resolver, который сам подписи не проверяет, по RFC 4035 не должен полагаться на AD, если резолвер не доверенный и канал до него не защищён.
- 1.1.1.1 валидирует DNSSEC. Ответ на `example.com A` выше пришёл с AD=true.

Чего DNSSEC не делает: не шифрует запрос, не прячет от провайдера, какие имена ты спрашиваешь, и не мешает резолверу просто не ответить или ответить заглушкой, если сам клиент подписи не проверяет.

## DoH и DoT

Обычный DNS идёт открытым текстом по UDP/TCP на порт 53. Два стандарта шифруют участок **от клиента до резолвера**:

- **DoT** (RFC 7858): DNS поверх TLS, TCP-порт 853. У Cloudflare это `one.one.one.one:853`.
- **DoH** (RFC 8484): DNS-сообщения внутри HTTPS (тип `application/dns-message`), порт 443. У Cloudflare это `https://cloudflare-dns.com/dns-query`.

RFC 7858 прямо ограничивает задачу участком stub → рекурсивный резолвер: дальше, от резолвера до авторитетных серверов, запросы идут как обычно. DoT живёт на отдельном порту 853, DoH идёт по 443 вместе с обычным HTTPS.

## Когда провайдер подменяет DNS

RFC 9499 называет это policy-implementing resolver: резолвер, который меняет часть ответов по своей политике, причём клиент обычно не знает, что и как меняется. На практике это заглушки вместо адреса, NXDOMAIN или SERVFAIL на «неправильные» домены.

Опыт сообщества:

- смена резолвера на Cloudflare или DoH помогает, когда домен режут на уровне DNS, см. [DNS-трюки](/baza/tspu/dns/);
- обратная ситуация на серверах: некоторые российские госдомены (например, `lknpd.nalog.ru`) через 1.1.1.1 и 8.8.8.8 отдают SERVFAIL, и их направляют на Яндекс DNS отдельным доменным правилом в `systemd-resolved`, см. [DNS в разделе «Сеть»](/baza/set/dns/);
- DNS внутри Xray (DoH, split по доменам) разобран там же.

## Команды

```bash
# вся цепочка от корня: dig сам ходит итеративно (и сам включает +dnssec)
dig +trace example.com A

# через конкретный резолвер, с DNSSEC: смотри флаг ad в заголовке и RRSIG в ответе
dig @1.1.1.1 example.com A +dnssec

# только ответ с TTL в человеческих единицах
dig +noall +answer +ttlunits example.com A

# TTL у двух резолверов: у каждого свой кэш и свой остаток
dig @1.1.1.1 +noall +answer example.com A
dig @8.8.8.8 +noall +answer example.com A

# отрицательный ответ: в authority будет SOA, последнее число в ней это MINIMUM
# (1.1.1.1 на такой запрос к example.com 2026-09-23 ответил NOERROR без записей, формально это NODATA)
dig @1.1.1.1 nonexistent-label.example.com A

# шифрованный транспорт: DoT (порт 853) и DoH (порт 443, путь /dns-query)
dig @1.1.1.1 +tls example.com A
dig @cloudflare-dns.com +https example.com A

# без dig: DoH JSON API Cloudflare
curl -s -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=example.com&type=A'
```

> [!NOTE]
> `+tls` и `+https` описаны в man dig из пакета `bind9-dnsutils` Debian trixie. Если твой dig их не знает, DoT можно проверить через `kdig -d @1.1.1.1 +tls-ca +tls-host=one.one.one.one example.com` (пример из документации Cloudflare).

## Наши тулзы

**[host.pink/dns/example.com](https://host.pink/dns/example.com)** спрашивает 1.1.1.1 через DoH с флагом DO и показывает A, AAAA, CNAME, NS, MX, TXT, CAA, HTTPS, SOA и DS. TTL в таблице показывает остаток в кэше 1.1.1.1 (плюс до 30 секунд нашего кэша), а не значение из зоны. Пометка «DNSSEC проверен» (в терминале «DNSSEC ok») означает, что 1.1.1.1 вернул AD. В терминале: `curl host.pink/dns/example.com`.

**[host.pink/check/example.com?t=dns](https://host.pink/check/example.com?t=dns)** запускает запрос `A` с проб Globalping в разных странах, включая домашних провайдеров РФ. Проба спрашивает свой системный резолвер, поэтому видно, что отвечает DNS конкретного провайдера, а не 1.1.1.1. Время означает полное время запроса к этому резолверу.

{{< bars caption="Время ответа на `example.com A` от системного резолвера проб Globalping. host.pink/check/example.com?t=dns&json, 2026-09-23 22:21 UTC, один замер" unit="мс" >}}
!Алматы, NLS Kazakhstan | 262
Курск, Kursktelecom | 110
Томск, дом. провайдер | 56
Буффало, HostPapa | 39
Москва, Yandex.Cloud | 12
Санкт-Петербург, Selectel | 8
Амстердам, DELUXHOST | 8
Сингапур, LeaseWeb | 4
Фалькенштайн, Hetzner | 1
Москва, Timeweb | 0
Новосибирск, МТС | 0
Хельсинки, Hetzner | 0
{{< /bars >}}

Как это читать. Globalping меряет полное время запроса к системному резолверу пробы, а не до авторитетного сервера example.com. Единицы миллисекунд означают резолвер в той же сети и, вероятно, ответ из его кэша. Сотни миллисекунд означают далёкий резолвер или поход за ответом по цепочке. Там же видно, что пробы получили разные адреса: часть 104.20.23.154 и 172.66.147.243, часть 8.6.112.0 и 8.47.69.0. Все четыре адреса анонсирует AS13335 Cloudflare. Авторитетные серверы часто отвечают по-разному в зависимости от того, откуда пришёл запрос (RFC 7871), так что разные ответы из разных сетей сами по себе ещё не признак подмены. Подмену выдаёт адрес, который не принадлежит сети владельца домена: проверь его в [досье IP](https://host.pink/1.1.1.1).

> [!TIP]
> Если сайт не открывается только из РФ, DNS проверяется первым делом, а весь порядок разбора есть в гайде [Сайт не открывается из РФ](/gaidy/sayt-ne-otkryvaetsya-iz-rf/). Про сертификаты и CAA: [TLS-сертификаты](/gaidy/tls-sertifikaty/).

## Источники

- RFC 1034, [Domain Names: Concepts and Facilities](https://www.rfc-editor.org/rfc/rfc1034); RFC 1035, [Implementation and Specification](https://www.rfc-editor.org/rfc/rfc1035)
- RFC 2181, [Clarifications to the DNS Specification](https://www.rfc-editor.org/rfc/rfc2181): TTL (раздел 8), MX и NS (10.3)
- RFC 2308, [Negative Caching of DNS Queries](https://www.rfc-editor.org/rfc/rfc2308)
- RFC 9499, [DNS Terminology](https://www.rfc-editor.org/rfc/rfc9499)
- RFC 4033, [DNS Security Introduction and Requirements](https://www.rfc-editor.org/rfc/rfc4033); RFC 4034, [Resource Records for the DNS Security Extensions](https://www.rfc-editor.org/rfc/rfc4034); RFC 4035, [Protocol Modifications for the DNS Security Extensions](https://www.rfc-editor.org/rfc/rfc4035)
- RFC 7858, [DNS over TLS](https://www.rfc-editor.org/rfc/rfc7858); RFC 8484, [DNS Queries over HTTPS](https://www.rfc-editor.org/rfc/rfc8484)
- RFC 8659, [CAA](https://www.rfc-editor.org/rfc/rfc8659); RFC 9460, [SVCB and HTTPS RR](https://www.rfc-editor.org/rfc/rfc9460); RFC 7871, [Client Subnet in DNS Queries](https://www.rfc-editor.org/rfc/rfc7871)
- RFC 7208, [SPF](https://www.rfc-editor.org/rfc/rfc7208); RFC 6376, [DKIM](https://www.rfc-editor.org/rfc/rfc6376); RFC 9989, [DMARC](https://www.rfc-editor.org/rfc/rfc9989)
- [root-servers.org](https://root-servers.org/): число корневых серверов и экземпляров на 2026-09-23
- Cloudflare 1.1.1.1: [DNS over TLS](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-tls/), [DoH: wireformat](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-wireformat/), [DoH: JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/), [FAQ (DNSSEC)](https://developers.cloudflare.com/1.1.1.1/faq/)
- [dig(1)](https://manpages.debian.org/trixie/bind9-dnsutils/dig.1.en.html), Debian trixie
- Globalping: [API](https://globalping.io/docs/api.globalping.io) (резолвер по умолчанию: системный резолвер пробы)
- Замеры: `curl -s "https://host.pink/check/example.com?t=dns&json"` и DoH-запросы к 1.1.1.1 и dns.google, 2026-09-23
