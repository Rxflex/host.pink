# host.pink

Справочник и сетевые тулзы для тех, кто держит серверы. Ноль клиентского JS, хостинг на бесплатном Cloudflare.

- **Доки** — Hugo, статика через Workers Static Assets (бесплатно и без лимитов). Контент: [BedolagaBD](https://github.com/Rxflex/BedolagaBD) (submodule, CC BY-SA 4.0) + свои гайды в `content/`.
- **Тулзы** — Worker (`worker/src`): досье IP/домена/ASN/префикса, DNS, TCP-пинг, проверка из стран через [Globalping](https://globalping.io) (фоллбек — эдж Cloudflare). HTML для браузера, цветной текст для curl (`curl host.pink` — гайд), `?json` для скриптов.
- **Поиск** — D1 + FTS5, индекс собирается из markdown (`scripts/build-search.mjs`).
- **ИИ** — Workers AI поверх того же индекса, ответ стримится HTML-ом. Кончился дневной лимит — отправляем на DeepWiki.
- **Каталоги** — хостеры, платёжки, защита от DDoS: карточки в `data/*/`, у каждого факта дата и пруф. Газета «Розовый вестник» (`data/gazeta/`) и словарь терминов с подсказками без JS (`data/glossary.json`).
- **hostpink** — TUI на Go (`tui/`): `curl -fsSL host.pink/tui | sh` или `irm host.pink/tui | iex`. Тулзы, база и плагины сообщества из реестра [hostpink-registry](https://github.com/Rxflex/hostpink-registry) (submodule).

## MCP

`https://host.pink/mcp` — MCP-сервер для агентов (`worker/src/mcp.ts`). Streamable HTTP без сессий и SSE: понимает и stateless-схему 2026-07-28 (`server/discover`, версия в заголовке `MCP-Protocol-Version`), и классическую `initialize` (2025-03-26 … 2025-11-25). Тулзы вызывают те же обработчики, что и сайт, в JSON-режиме, лимиты общие. В браузере по тому же адресу — инструкция по подключению.

```bash
claude mcp add --transport http host-pink https://host.pink/mcp
```

## Разработка

```bash
git submodule update --init
npm ci
npm run dev:local     # всё, кроме ИИ, без аккаунта Cloudflare: http://127.0.0.1:8787
npm run dev:site      # только статика с hugo server
```

`npm run build` = импорт BedolagaBD → QR для донатов → зеркало реестра плагинов → сборка hostpink под 8 платформ (нужен Go 1.26+) → Hugo → подсказки словаря → llms.txt → проверка, что в `public/` нет ни строчки JS.

TUI отдельно: `npm run tui:test` (vet и тесты), `npm run tui` (бинарники в `.generated/static/dl/`). Запуск против локального сайта: `HOSTPINK_SITE=http://127.0.0.1:8787 go run ./tui`.

## Первый деплой

```bash
npx wrangler login
npx wrangler d1 create host-pink        # id вставить в wrangler.jsonc (d1_databases, оба места)
npm run search:remote                   # залить поисковый индекс
npm run deploy
```

Домен привязан через `routes` в `wrangler.jsonc` (custom domain).

### Globalping (необязательно)

Без токена Globalping даёт 250 проб в час с IP, и эти IP у Cloudflare общие с другими сайтами. Бесплатный токен с [dash.globalping.io](https://dash.globalping.io) даёт 500 проб в час на нас лично:

```bash
npx wrangler secret put GLOBALPING_TOKEN
```

Ещё больше бесплатно: поставить пробу Globalping на свой VPS (`docker run -d --network host --restart=always --name globalping-probe globalping/globalping-probe`) и привязать её к аккаунту — за работающую пробу начисляются кредиты.

Дальше деплоит GitHub Actions (`.github/workflows/deploy.yml`): нужны секреты `CLOUDFLARE_API_TOKEN` (права Workers Scripts, D1, Workers AI) и `CLOUDFLARE_ACCOUNT_ID`. По понедельникам workflow сам подтягивает свежую BedolagaBD и переиндексирует поиск.

## Спонсоры

Всё в `data/sponsors.json`: его читают и Hugo, и Worker. Где показываются:

- главная и `/sponsors/` — все спонсоры рядом, каждый в своём фирменном стиле (разметка в `layouts/_partials/sponsor.html`, стили в `site.css`, блок «спонсоры»);
- конец статьи — один спонсор, выбирается по хешу адреса страницы: без JS, но по сайту они чередуются;
- полоса над подвалом и `curl host.pink` — все;
- строка в конце текстовых досье — случайный спонсор;
- досье домена без DDoS-защиты — спонсор с темой `ddos` в поле `topics`.

Новый спонсор со своим стилем: запись в JSON, ветка в `sponsor.html` и `sponsor-logo.html`, блок CSS `.sp-<id>`, знак в `worker/src/ansi.ts` (`mark`). Ссылки размечены `rel="sponsored"` и UTM-метками по месту показа (`utm_campaign=home`, `doc-baza`, `curl-home`…).

## Бюджет Cloudflare Free

| Что | Лимит | Сколько тратим |
|---|---|---|
| Статика | без лимита | все доки, главная, донаты |
| Worker | 100k запросов/день, 10 мс CPU | только тулзы, поиск, ИИ; CPU почти весь уходит на ожидание сети, а оно не считается |
| Subrequests | 50 на запрос | самое тяжёлое досье IP — около 20 |
| Globalping | 250 проб/час (500 с токеном) | `/check` — 12 проб, досье домена — 5; одинаковые проверки кешируются на 2 минуты |
| D1 | 5M чтений/день | один запрос на поиск |
| Workers AI | 10k нейронов/день | кеш ответов на сутки, 3 вопроса/мин с IP |

## Лицензии и авторство

Required Notice: Copyright (c) 2026 Rxflex (https://github.com/Rxflex, https://host.pink)

| Что | Лицензия |
|---|---|
| Код: сайт, Worker, скрипты сборки, шаблоны, TUI `hostpink` | [PolyForm Noncommercial 1.0.0](LICENSE.md) |
| Наши тексты: гайды `content/gaidy/` и описания страниц | [CC BY-NC-SA 4.0](LICENSE-CONTENT.md) |
| База [BedolagaBD](https://github.com/Rxflex/BedolagaBD) и всё, что её пересказывает: импорт `/baza/`, карточки хостеров, платёжек и защиты, газета, словарь | CC BY-SA 4.0, как у источника |
| Шрифты Golos Text и Martian Mono (`static/fonts/`) | SIL OFL 1.1 |
| Плагины hostpink | лицензии их авторов, код лежит в их репозиториях |

Проще говоря: пользоваться, менять и делиться можно бесплатно, если это не коммерция и указан автор. Продавать, встраивать в платный продукт или сервис нельзя без отдельного разрешения. Исключение — пересказ BedolagaBD: исходная CC BY-SA 4.0 запрещает добавлять ограничения, поэтому эти материалы остаются под ней.
