# PROJECT_AUDIT.md — Bob Smoke (Telegram Mini App + Back-office)

Дата аудиту: 2026‑11‑12. Гілка: `hoplite/siris-9ea033ef`. Архів «Архів 4.zip» побайтово збігається з репозиторієм (єдина відмінність — стороння `.docx` у `frontend/miniapp/css/`), тому аудит виконано безпосередньо по репозиторію.

> Умовні позначення: `R/` = корінь репозиторію; `file:N` = рядок N. Усе, що позначено **(перевірено)**, виконувалось у пісочниці (pytest, uvicorn, headless‑Chrome). Усе, що позначено **(не перевірено)**, ґрунтується лише на читанні коду.

---

## 1. Огляд проєкту

**Bob Smoke** — магазин вейп‑продукції (под‑системи, рідини, картриджі, підсилювачі) у форматі **Telegram Mini App** з двома режимами замовлення (опт / роздріб), оформленням через Нову пошту, промокодами, реферальною програмою та повноцінною адмін‑панеллю (товари, лінійки й ціни, замовлення, чати з покупцями, користувачі, реферали, розсилки, налаштування, Excel‑синхронізація).

Один процес FastAPI одночасно віддає API, статичний Mini App (`/app/`), статичну адмін‑панель (`/admin/`) і приймає вебхук Telegram‑бота. Дані — MongoDB (Atlas у продакшені). Деплой — один web‑сервіс на Render без Node і без кроку збірки фронтенду.

---

## 2. Архітектура

```
Telegram клієнт ──(Mini App WebView)──► /app/  (frontend/miniapp, vanilla ES‑modules)
       │                                   │  fetch /api/shop/*  (заголовок X-Telegram-Init-Data)
       │ /start, чат, my_chat_member       ▼
       └──► POST /telegram/webhook ──► backend/main.py (FastAPI) ──► MongoDB
                                           ▲   routes/* → services/*
Браузер адміністратора ──► /admin/ (frontend/admin) ── fetch /api/* (JWT Bearer)
Фонові потоки: setup_webhook, keepalive (/health), user_sync.schedule_loop, broadcast.run
Зовнішні API: api.telegram.org, api.novaposhta.ua (лише пошук міст/відділень)
```

- **Фронтенд ↔ бекенд контракт:** лише HTTP JSON. Mini App — 8 ендпоінтів `/api/shop/*`; адмінка — ~45 ендпоінтів `/api/*`. Жоден тест або конфіг деплою не посилається на внутрішню структуру фронтенду → фронтенд можна переписувати вільно, зберігаючи контракт API, hash‑роутинг (`/app/<path>` не має SPA‑fallback: `GET /app/catalog/x` → 404 **(перевірено)**) та ключ `localStorage` `miniapp_state_v2`.
- **Статика:** `/app` і `/admin` монтуються через `StaticFiles(html=True)` з `Cache-Control: no-cache` (ETag‑ревалідація), `/img/*` — `immutable, 7 днів`, `/api/*` — `no-store` (`backend/main.py:65-76`).

---

## 3. Повна структура проєкту

```
R/
├── backend/
│   ├── main.py            # FastAPI app, lifespan (індекси, вебхук, keepalive, user-sync), статика, cache-заголовки
│   ├── config.py          # усі ENV-налаштування (lazy properties), читає R/.env
│   ├── database.py        # MongoClient, ensure_indexes, Decimal128 ↔ Decimal, public()
│   ├── cli.py             # create-admin | import-products [--apply] | purge-blocked
│   ├── auth/security.py   # argon2, JWT HS256, lockout 5 спроб/15 хв, current_admin
│   ├── models/schemas.py  # pydantic-схеми (ProductIn/Patch, OrderIn, ShopOrderIn, …)
│   ├── routes/            # 17 роутерів: auth, products, lines, media, pricing, imports, sync, orders,
│   │                      #   settings, bot(legacy), broadcast, chats, shop, telegram, users, promo, referrals
│   ├── services/          # бізнес-логіка (див. §6): pricing, discounts, promo, referral, orders, lines,
│   │                      #   catalog, compliance(stub), shop_settings, telegram_api, telegram_auth,
│   │                      #   subscription, user_sync, broadcast, chat, order_messages, receipt, images,
│   │                      #   importer, sheet_sync, photo_archive, devblog, validators
│   ├── assets/fonts/      # Liberation Sans для чеків (logo.png відсутній → малюється «B»)
│   ├── banner.jpg         # не використовується
│   └── render.yaml        # дублікат кореневого render.yaml
├── bot/
│   ├── shop_bot.py        # вебхук-бот (у процесі web-app): /start, реферали, чат-інбокс, my_chat_member
│   ├── main.py, api.py    # застарілий polling-бот оператора (не запускається на Render)
│   └── novaposhta.py      # Address.searchSettlements / Address.getWarehouses
├── frontend/
│   ├── miniapp/           # index.html, css/styles.css (645 р.), js/{app.js 1111 р., api.js, data.js, store.js}, img/
│   └── admin/             # index.html (293 р.), css/admin.css (445 р.), js/admin.js (960 р.), img/{logo.png, banner.webp}
├── imports/               # products_clean.json (800 рядків), images/ (36 webp), import_report.md
├── tests/                 # 23 файли, 200 тестів (pytest + mongomock), run_pure.py
├── bobsmoke_full_project/ # ЗАСТАРІЛА КОПІЯ проєкту (відрізняються лише 3 файли miniapp). Ламає `pytest` без аргументів.
├── promo-referral.patch   # застосований патч (72 КБ), артефакт
├── requirements.txt, requirements-dev.txt, render.yaml, docker-compose.yml (лише mongo:7), .env.example, .python-version
```

---

## 4. Технології та залежності

| Шар | Технологія | Версія (зафіксована / розв’язана у пісочниці) |
|---|---|---|
| Мова | Python | 3.12.3 (`.python-version`; код використовує `\` у f‑string → потрібен ≥3.12) |
| Web | FastAPI / Starlette / uvicorn[standard] | `>=0.110` → 0.162.5 / 1.10 / 0.54 |
| БД | MongoDB 7 (Atlas), pymongo[srv], certifi | `>=4.7` → 4.19 (extra `srv` відсутній у 4.19 — попередження pip) |
| Валідація | pydantic v2 | `>=2.6` → 2.14 |
| Безпека | argon2‑cffi, PyJWT | `>=23.1`, `>=2.8` |
| Інше | requests, Pillow (чеки, WebP), openpyxl (Excel‑синк), python‑multipart, tzdata | Pillow 13 |
| Dev | pytest, httpx, mongomock, pyTelegramBotAPI (лише legacy‑бот) | |
| Фронтенд | Vanilla HTML/CSS/ES‑modules, **без збірки і без npm** | — |
| Фронтенд CDN | Telegram WebApp SDK; Google Fonts (Inter, Inter Tight, Unbounded, Material Symbols; адмінка: Inter, Anton); three.js 0.160 (jsDelivr, без SRI, ~167 КБ gzip) | — |
| Деплой | Render Blueprint: `pip install -r requirements.txt` → `uvicorn backend.main:app`, healthcheck `/health`, Frankfurt, free‑план + self‑keepalive | — |

Усі залежності не закріплені (`>=`), lock‑файла немає.

---

## 5. Аналіз фронтенду

### 5.1 Mini App (`frontend/miniapp`)

**Модулі:** `app.js` (роутер, усі екрани, ефекти головної, оформлення, гейти) → `data.js` (каталог, `applyMode`) → `api.js` (fetch з `X-Telegram-Init-Data`, мапінг помилок) ; `store.js` (кошик/обране/профіль/режим у `localStorage['miniapp_state_v2']`, синхронізація кошика `PUT /cart` з дебаунсом 1,5 с).

**Роутинг (hash):** `#/home`, `#/catalog`, `#/catalog/:cat`, `#/search`, `#/cart`, `#/checkout`, `#/product/:id`, `#/profile`, `#/profile/orders[/:number]`, `#/profile/favs`, `#/profile/invite`, `#/profile/info`, `#/profile/help`, `#/profile/about`; невідомий → «Сторінку не знайдено». Власний стек навігації + збереження позиції скролу; Telegram BackButton ховається лише на 5 кореневих вкладках.

**Старт:** `tg.ready/expand/setHeaderColor/setBackgroundColor`, `BackButton.onClick(back)` → `GET /catalog` → `pruneCart()` → `applyMode()` → **повноекранний гейт вибору режиму (опт/роздріб) з підтвердженням 18+ на кожному запуску** → `render()`. 403 `subscribe_required` → гейт підписки на канал. Старий окремий 18+ гейт (`gate()`, `#gate`) — мертвий код.

**Делегування подій:** один `click`‑обробник на `document` з `data-*` атрибутами (`go, back, pick, fav, add, addv, var, mg, qty, rm, sort, brand, q, clear, city, wh, copy, share, pickmode, act=*`), `input` (`data-promo`, `data-f`, `#cityq`, `#whq`, `#q`), `change` (`pay`), `keydown`, `focusin/out` (клас `kb`).

**Екрани й дані** (деталі рядків UI — у §9):
- *Головна* — «Vapor Depth»: хедер, hero з 3D‑монетою (CSS + опційно three.js), лічильники, біжучий рядок брендів, плитки категорій, «Гаряче зараз» (3D‑кільце при ≥5 hot‑варіантів або coverflow), «Наш вибір», «Щойно надійшло»/«Улюблене клієнтів» (**ніколи не рендеряться**, бо `isNew/isPopular` завжди `false` — `services/catalog.py:131`), «Вам може сподобатись», фінальний блок.
- *Каталог* — великі картки категорій + **усі 79 груп одним гридом без пагінації**.
- *Категорія* — сегмент сортування («🔥 Hot», «Дешевші», «Дорожчі»), чіпи брендів, грид.
- *Товар* — фото, бейджі, варіанти (Смак/Колір/Опір/Варіант), міцність нікотину (рідини), опис, характеристики, нижня панель (додати / степер / недоступно).
- *Пошук* — клієнтський, по всіх словах, без дебаунсу; порожній запит → «Популярні запити» (перші 8 брендів) + категорії.
- *Кошик* — рядки зі степером, підсумок, знижка за сумою (лише опт), підказка «Ще X ₴ до знижки», мінімальна сума, кнопка «Перейти до оформлення».
- *Оформлення* — ім’я/прізвище/телефон (валідація UA‑номера), місто НП (пошук ≥2 літер, дебаунс 350 мс, `npSeq` проти гонок), відділення (пагінація по 20, «Показати ще»), промокод (`POST /promo/check`), спосіб оплати (накладений / повна оплата; текст передоплати при `prepay_enabled`), підсумок, `POST /orders`, екран успіху.
- *Профіль* — аватар Telegram, меню; *Мої замовлення* (`GET /orders`, кеш на сесію), деталі; *Обране* (локально); *Запросити друга* (`GET /referral`, share/copy, персональні промокоди); *Особисті дані*; *Допомога* (FAQ + підтримка через `SHOP.contact`); *Про магазин*.

**Повторно використовувані хелпери:** `esc, money, pl, ic/P (inline SVG), art, media, badges, favBtn, cardAction, card, head, empty, loading, discRows, minNote, phoneOk, copyText`. **Дублікати:** дві паралельні дизайн‑системи (`.card/.bigcat/.sec` проти `.hm .x-*` з перевизначенням токенів), 6 варіантів картки товару (`card, hCf, hRt, hTile, hFeat, hRow`), 2 реалізації картки категорії, 4 системи іконок (inline SVG, `MG_ICO`, Material Symbols, емодзі), ~40 inline `style=`.

**Проблемні/застарілі рішення:** three.js + CSS‑монета з 17 шарами і вічним rAF‑циклом; 19 `backdrop-filter`, 8 `preserve-3d`, 9 `mix-blend-mode` у CSS; `user-scalable=no`; картки‑`div` без клавіатурного доступу; гейти без `role=dialog`/focus‑trap; `ordersCache` не оновлюється протягом сесії; Material Symbols з `display=block` → при блокуванні шрифту видно англійські лігатури (`arrow_forward`, `shopping_bag`…); два різні логотипи (жовте кільце `logo.jpg` у хедері/гейті проти лаймового `logo.png` у монеті/адмінці).

### 5.2 Адмін‑панель (`frontend/admin`)

Один `index.html` з секціями `#login`, `#app` (хедер з вкладками `products, lines, orders, chats, users, referrals`, меню користувача з «Розсилка» та «Налаштування»), виглядами `#productsView … #settingsView`, оверлеями `#syncPanel` (Excel), `#lpanel` (ціни лінійки), `#drawer` (форма товару), `#scrim`, `#toast`. `admin.js` — `api()` з Bearer‑токеном з `localStorage['admin_token']`, `toast`, рендери таблиць/карток, polling чатів (15 с, **інтервали накопичуються після повторного логіну**), прогрес розсилки/синку (2 с). Діалоги підтвердження — **8 нативних `confirm()` і 1 `prompt()`** (мова браузера, без стилів). `admin.css` — **чотири нашаровані теми** (базова світла + OS‑dark, «iOS glass», «Obsidian Vapor», «Rebrand»), `:root` перевизначено 5 разів, `!important` з ранніх шарів робить пізніші правила мертвими; мобільна таблиця товарів накладає дві цінові клітинки в одну (`td.t-price{grid-column:3}`).

---

## 6. Аналіз бекенду

### 6.1 Конфігурація (`backend/config.py`)
`MONGODB_URI`, `MONGODB_DATABASE=backoffice`, `JWT_SECRET` (≥32 симв., перевіряється ліниво), `TOKEN_TTL_MINUTES=480`, `IMAGES_DIR`, `BOT_TOKEN`, `BOT_USERNAME`, `WEBHOOK_SECRET`, `PUBLIC_URL`/`RENDER_EXTERNAL_URL`, `BOT_ALLOWED_IDS` (оператори), `MINIAPP_ALLOWED_IDS`, `REQUIRED_CHANNEL` (типово `@bobsmoke_opt`, `off` вимикає), `REQUIRED_CHANNEL_LINK`, `MINIAPP_DEV_MODE`, `INIT_DATA_TTL_SECONDS=86400`, `SHOW_BLOCKED` (мертве), `NOVA_POSHTA_API_KEY`, `ORDERS_PER_HOUR=5`, `MIN_ORDER_TOTAL=1500`, `MIN_ORDER_RETAIL=500`, `RETAIL_MARKUP=100`, `PREPAY_ENABLED=0`, `PREPAY_AMOUNT=100`, `USER_SYNC_HOURS=24`, `KEEPALIVE_SECONDS=600`, `PAYMENT_CARD`, `MANAGER_USERNAME=@ikwig337`, `CHAT_ACK_MINUTES=30`. Значення з дашборда (`settings.general`) мають пріоритет над ENV для назви магазину, мінімумів, націнки, знижок, реферальних відсотків, картки, менеджера.

### 6.2 Автентифікація
- **Адмін:** `POST /api/auth/login` → JWT HS256 `{sub, exp}`; `current_admin` перевіряє токен і наявність адміна в `admins` на кожен запит; argon2id; 5 невдалих спроб → блокування 15 хв (429). Адмінів створює лише CLI.
- **Mini App:** заголовок `X-Telegram-Init-Data` → `validate_init_data` (HMAC‑SHA256 з ключем `WebAppData`, TTL 24 год, ліміт 8 КБ) → `tg_user`. Далі allow‑list (`403 Доступу немає`) та перевірка підписки на канал (`403 {code:"subscribe_required", channel, link, message}`; fail‑open, позитивний результат кешується 600 с; оператори звільнені). `MINIAPP_DEV_MODE=1` без заголовка → користувач `id=0` («Dev»), allow‑list і підписка пропускаються.

### 6.3 Бізнес‑правила (services)
- **Ціни:** `final_price = purchase + фіксована націнка категорії` (liquid 10, pod 70, cartridge 15, booster 0 ₴; `settings.markups`). **Роздріб** = опт + власна `retail_markup` товару або загальна (100 ₴), **картриджі без націнки**. Клієнт обирає `order_type` сам; відмінність — лише мінімум і знижки.
- **Мінімум замовлення:** опт 1500 ₴ / роздріб 500 ₴ (дашборд → ENV → типово), перевіряється по сумі товарів до знижок.
- **Знижки за сумою (лише опт):** 10k→2 %, 20k→3 %, 30k→4 %, 40k→5 %, 50k→6 %, 70k→8 %, 90k→10 % (до 30 рівнів у налаштуваннях, `[]` вимикає).
- **Промокоди:** `%` від суми товарів, додається до знижки за сумою, обмежується сумою; один код на замовлення; одноразове використання на клієнта (`used_by`), ліміт використань, термін дії, персональні коди; `redeem` атомарний, `release` при невдачі; `/promo/check` не витрачає код.
- **Реферали:** посилання `https://t.me/<bot>?start=ref_<id>`; друг отримує одноразовий код (типово 3 %) при `/start`, запрошувач — коли перше замовлення друга стає `done` (типово 3 %) + DM.
- **Замовлення:** `ORD-YYYYMMDD-NNNN` (атомарний лічильник за UTC‑добу); статуси `new → confirmed → packing → shipped → done`, `rejected`, legacy `in_progress`, `cancelled`; **переходи не обмежені**; ціни/собівартість/прибуток заморожуються з БД; ліміт 5 замовлень/год на tg_id (неатомарно); оплата — переказ на картку (без шлюзу): `cod` (накладений, опційна передоплата) або `prepaid`; після створення — фоново текст операторам + HTML‑подяка і PNG‑чек покупцю (`deliver_order`), лог у `messages/chats`.
- **Наявність:** лише статуси `in_stock` (можна замовити), `expected` (видно, не можна), `unavailable` (сховано). Кількісних залишків немає. **Compliance‑гейт вимкнено:** `compliance.classify()` завжди `ok`, `catalog.py:75` `blocked=False`, хоча імпорт позначає 589 рідин `blocked_by_law` (див. §12).
- **Рідини:** міцність 50/65 мг + власна; `nicotine_mg` валідується сервером; рядок кошика = `(product_id, mg)`.
- **Інше:** `subscription` (getChatMember), `user_sync` (видалення користувачів, що заблокували бота: update, 403 у розсилці, sweep 20/с), `broadcast` (25 msg/с, повтор на 429, скасування), `chat` (інбокс, ack раз на 30 хв), `devblog` (дайджести змін операторам), `sheet_sync` (xlsx постачальника → сесія рішень, TTL 7 днів), `images` (WebP ≤1200 px у Mongo `media`), `photo_archive` (фото видалених товарів повертаються за `dedupe_key`), `receipt` (Pillow, 900 px, лого `backend/assets/logo.png` відсутнє → малюється «B»).

### 6.4 Боти
- `bot/shop_bot.py` (вебхук у web‑процесі): `setWebhook({PUBLIC_URL}/telegram/webhook, secret=sha256("tgwh:"+secret))`, `setChatMenuButton(web_app «Магазин»)`, `setMyCommands`. Обробляє приватні `message` і `my_chat_member`; `/start [ref_<id>]` → реєстрація, DM операторам «🆕 Новий користувач», реферал; не‑команди → чат‑інбокс; без `PUBLIC_URL` — «Магазин ще налаштовується…». Кнопка «🛍 Відкрити магазин» веде на `{PUBLIC_URL}/app/`.
- `bot/main.py` + `bot/api.py` — legacy polling‑бот оператора (інший токен, REST через JWT, кошики `/api/bot/cart`). Ніде не запускається й не тестується.
- `bot/novaposhta.py` — `searchSettlements` (≤8, лише з відділеннями) і `getWarehouses` (20/стор.).

---

## 7. Документація API

Формат помилок: `{"detail": str | list | {…}}`; службові повідомлення українською; pydantic‑422 — масив (англ.), обидва фронтенди підмінюють його загальним українським текстом. Гроші: shop‑API — числа; admin‑API — рядки (`"1764.00"`).

### 7.1 Публічні
| Метод і шлях | Опис |
|---|---|
| `GET /health` | `{ok:true}` або 503 `{ok:false}` (ping Mongo) |
| `GET /` | 307 → `/admin/` (або `/app/`, якщо адмінки немає) |
| `GET /openapi.json` | схема (docs/redoc вимкнені) |
| `POST /telegram/webhook` | заголовок `X-Telegram-Bot-Api-Secret-Token`; завжди `{ok:true}` |
| `GET /img/{name}` | `^[A-Za-z0-9._-]{1,80}$`; `IMAGES_DIR` → Mongo `media` → 404 |

### 7.2 Mini App `/api/shop/*` (усі — initData)
| Ендпоінт | Вхід → Вихід |
|---|---|
| `GET /catalog` | → `{categories:[{id,title,sub,hue,image?}], products:[{id,name,category,brand,image,attributes{},isNew,isPopular,isHot,variants:[{id,label,image,price,rm,inStock,expected,blocked,hot,purchasable,nicotine?}],strengths?,price,purchasable,expected,blocked,description}], shop:{min_order,min_order_retail,retail_markup,discounts[{from,percent}],prepay,prepay_enabled,name,slogan,contact,about,hours,hero_title,hero_text}}`; кеш 60 с; оновлює `users.last_seen_at` |
| `PUT /cart` | `{items:[{product_id,qty 1‑99,nicotine_mg?}]≤100}` → `{ok}`; копія кошика для дашборда |
| `POST /promo/check` | `{code}` → `{code,percent}` або 422 з причиною |
| `GET /referral` | → `{link,invited,rewarded,reward_percent,friend_percent,codes:[{code,percent}]}`; 403 для id≤0 |
| `GET /np/cities?q=` | ≥2 символи → `[{city,area,region,present,city_ref}]` (≤8); 503 без ключа; 502 при збої НП |
| `GET /np/warehouses?city_ref&q&page` | → `[{title,ref,number}]` (20/стор., page 1‑200) |
| `POST /orders` → 201 | `{first_name,last_name,phone,delivery{carrier:"nova_poshta",city,area,warehouse,city_ref,warehouse_ref},items[{product_id,qty,nicotine_mg?}],order_type,payment_method,promo_code?}` → `{number,total,status,payment_method,prepay}`; 422 (мінімум, наявність, промокод), 429 (ліміт) |
| `GET /orders` | → `[{number,created_at,status,status_label,status_reason,total,discount,items:[{name,qty,unit_price,line_total}]}]` (≤30, новіші першими) |

### 7.3 Адмін `/api/*` (усі — JWT; «А» = використовує поточна адмінка)
| Група | Ендпоінти |
|---|---|
| Auth | `POST /api/auth/login` (публічний) → `{token}` А; `GET /api/auth/me` А |
| Товари | `GET /api/products?q,category,brand,status,compliance,line,hot,needs_content,sort,page,limit` → `{items,total,page,pages}` А; `POST /api/products` А; `GET /api/products/{id}`; `PATCH /api/products/{id}?apply_image_to_group` А; `DELETE /api/products/{id}?confirm=true` А; `GET /api/brands`; `GET /api/categories` А; `GET /api/product-lines`; `POST /api/products/bulk-line-price`; `POST /api/products/bulk-line-retail-price`; `DELETE /api/product-lines/{line}`; `GET /api/media/{name}` |
| Лінійки/ціни | `GET /api/lines` А; `POST /api/lines/price {line_key,wholesale?{mode,value},retail?,reset_retail,dry_run}` А; `POST /api/lines/assign`; `GET /api/pricing/markups` А; `POST /api/pricing/markups/preview`; `PUT /api/pricing/markups` |
| Замовлення | `GET /api/orders?number,status,active,date_from,date_to,page` → `{items,total,statuses,active_count}` А; `POST /api/orders`; `PATCH /api/orders/{n}/status {status,reason,notify}` А; `POST /api/orders/{n}/notes`; `GET /api/orders/{n}/receipt.png` А; `POST /api/orders/{n}/resend` А |
| Налаштування | `GET/PUT /api/settings` (17 ключів: shop_name, slogan, contact, about, hours, hero_title, hero_text, popular_categories, payment_card, manager_username, receipt_title, min_order_total, min_order_retail, retail_markup, discount_tiers, referral_reward_percent, referral_friend_percent) А |
| Промокоди | `GET/POST /api/promo`, `PATCH/DELETE /api/promo/{code}` А |
| Реферали | `GET /api/referrals?days` → `{summary,rows,recent}` А |
| Користувачі | `GET /api/users?q,limit` А; `GET/POST /api/users/sync` А |
| Чати | `GET /api/chats` А; `GET /api/chats/{id}` (позначає прочитаним) А; `POST /api/chats/{id}/messages` А; `GET /api/chats/{id}/photo/{msg}` А |
| Розсилки | `GET/POST /api/broadcast` А; `POST /api/broadcast/test` А; `POST/DELETE /api/broadcast/attachments[/{id}]` А; `GET /api/broadcast/{id}`; `POST /api/broadcast/{id}/cancel` А |
| Медіа/імпорт/синк | `POST /api/media` (≤8 МБ, → WebP) А; `POST /api/sync/upload` (.xlsx ≤60 МБ) А; `GET /api/sync/session` А; `DELETE /api/sync/session/{id}`; `POST /api/sync/session/{id}/decide` А; `POST /api/import?dry_run` |
| Legacy | `GET/PUT /api/bot/cart/{tg_id}` |

---

## 8. Структура MongoDB

Індекси створюються в `ensure_indexes` (lifespan і CLI), помилка лише логується (одна невдача пропускає решту).

| Колекція | Ключові поля | Індекси |
|---|---|---|
| `products` | name, brand, category(liquid/pod/cartridge/booster), category_label, product_line, custom_line, model, variant, volume_ml, nicotine_mg, pack_size, sku, purchase_price(Decimal128), usdt{}, markup, final_price, retail_markup, status(in_stock/expected/unavailable), status_label, images[], image_scope, hot, needs_content, dedupe_key, internal{}, compliance{}, created_at/updated_at | `dedupe_key` uniq, `(category,brand)`, `name`, `final_price`, `status` |
| `orders` | number, status, status_reason, order_type, customer{name,contact,phone,tg_id,tg_username,delivery{…}}, items[{product_id,name,display_name,brand,title,attrs,category,qty,unit_price,discount,line_total,purchase_price,profit,nicotine_mg}], subtotal, discount, discount_percent, promo{}, total, profit, payment{method,label,prepay_amount}, prepay_consent{}, history[], notes[], customer_notified{}, created_by, created_at/updated_at | `number` uniq, `(status,created_at)`, `(customer.tg_id,created_at)` |
| `users` (`_id`=tg id) | first_name, last_name, username, registered_at, last_seen_at, referred_by, referred_at, referral_rewarded, referral_order, bot_blocked | `referred_by` |
| `carts` (`_id`=tg id) | items[{product_id,qty,nicotine_mg}], updated_at | — |
| `settings` | `_id:general` (див. §7.3), `_id:markups {values}` | — |
| `promo_codes` (`_id`=код) | percent, active, kind(manual/referral_friend/referral_reward), owner_tg_id, uses_left, max_uses, used, used_by[], expires_at, created_at | `owner_tg_id` |
| `chats` (`_id`=tg id) | last_text, last_dir, last_at, unread, name, username, last_ack_at | `last_at` |
| `messages` | tg_id, dir(in/out), text, kind, at, media{}, tg_message_id, by | `(tg_id,at)` |
| `broadcasts` / `broadcast_files` | text, preview, button, total/sent/failed/blocked, status, attachments[] / name, kind, mime, size, data(Binary) | `(broadcast,created_at)` |
| `media` (`_id`=`<sha1>.webp`) | data(Binary), type | — |
| `photo_archive` (`_id`=dedupe_key) | images, image_scope, archived_at | — |
| `sync_sessions` | filename, items[], report, warnings | TTL 7 днів |
| `counters`, `user_sync`, `admins`(username uniq), `audit_log`(at) | | |

---

## 9. Повний інвентар функцій (статус перевірки)

| # | Функція | Де реалізовано | API | Статус |
|---|---|---|---|---|
| 1 | Завантаження каталогу, групування варіантів | `data.js`, `services/catalog.py` | `GET /catalog` | **Працює (перевірено:** 79 груп / 800 варіантів, 191 КБ) |
| 2 | Гейт вибору режиму опт/роздріб + 18+ | `app.js openModeGate/chooseMode` | — | Працює (перевірено) |
| 3 | Перерахунок цін для роздрібу (націнка, картриджі без) | `data.js applyMode` ↔ `orders.py` | — | Працює (логіка збігається з сервером) |
| 4 | Головна з секціями/ефектами | `app.js home/initHome…` | — | Працює (перевірено); секції Новинки/Хіти мертві |
| 5 | Каталог / категорія / сортування / фільтр брендів | `catalog(), category()` | — | Працює (перевірено) |
| 6 | Сторінка товару, вибір варіанта і міцності | `product(), renderBar()` | — | Працює (перевірено) |
| 7 | Пошук | `search(), searchBody()` | — | Працює (перевірено) |
| 8 | Кошик (+1/−1, видалення, ліміт 99, прибирання недоступних) | `store.js`, `cart()` | `PUT /cart` | Працює (перевірено в браузері) |
| 9 | Обране | `store.js`, `favs()` | — (localStorage) | Працює |
| 10 | Знижка за сумою / підказка наступного рівня | `discInfo()` ↔ `discounts.py` | — | Працює |
| 11 | Промокод | `applyPromo()` | `POST /promo/check` | Працює (тести `test_promo_referral`) |
| 12 | Пошук міста/відділення НП | `loadCities/loadWh` | `/np/*` | **Не перевірено наживо** (потрібен `NOVA_POSHTA_API_KEY`); без ключа — 503 з укр. текстом |
| 13 | Оформлення замовлення, валідація, екран успіху | `submitOrder()` | `POST /orders` | Працює (тести `test_shop_api`; створення перевірено з фіктивними refs) |
| 14 | Мої замовлення / деталі | `orders(), orderDetail()` | `GET /orders` | Працює |
| 15 | Реферальна програма (посилання, коди, статистика) | `invite()` | `GET /referral` | Працює за тестами; у dev‑режимі (id=0) — 403 |
| 16 | Гейт підписки на канал | `showSubGate()` | 403 `subscribe_required` | **Не перевірено наживо** (потрібен бот‑адмін каналу) |
| 17 | Повідомлення/чек покупцю та операторам | `order_messages`, `receipt` | фоново | Тести є; наживо не перевірено (немає `BOT_TOKEN`) |
| 18 | Чат із менеджером через бота | `shop_bot.py`, `routes/chats.py` | адмін‑API | Тести є (1 застарілий) |
| 19 | Адмін: логін/JWT/lockout | `auth/security.py` | `/api/auth/*` | Працює (перевірено логін) |
| 20 | Адмін: товари (список, фільтри, редактор, фото, hot, inline‑ціни, видалення) | `admin.js` | `/api/products*`, `/api/media` | Працює (перевірено список) |
| 21 | Адмін: лінійки та масова зміна цін (dry‑run) | `renderLines`, `#lpanel` | `/api/lines*` | Працює за кодом |
| 22 | Адмін: Excel‑синхронізація | `#syncPanel` | `/api/sync/*` | Тести `test_sheet_sync` (23) |
| 23 | Адмін: замовлення (статус, коментар, сповіщення, чек, повторна відправка) | `renderOrders` | `/api/orders*` | Працює за кодом |
| 24 | Адмін: чати (список, перегляд, відповідь, фото) | chats | `/api/chats*` | Працює за кодом |
| 25 | Адмін: користувачі, активні кошики, очищення заблокованих | `renderUsers` | `/api/users*` | Працює за кодом |
| 26 | Адмін: реферали (рейтинг за період) | referrals | `/api/referrals` | Працює за кодом |
| 27 | Адмін: розсилки (вкладення, тест, прогрес, скасування) | broadcast | `/api/broadcast*` | Тести (31) |
| 28 | Адмін: налаштування (магазин, оплата, мінімуми, знижки, реферали, категорії, промокоди) | `#settingsForm` | `/api/settings`, `/api/promo` | Працює за кодом |
| 29 | CLI: create‑admin, import‑products, purge‑blocked | `cli.py` | — | Працює (перевірено 1, 2) |
| 30 | Keepalive, user‑sync, вебхук при старті | `main.py` | — | Не перевірено (потрібен HTTPS/бот) |

---

## 10. Наявні баги

**Базовий стан тестів (перевірено):** `pytest tests/` → 195 passed, 5 failed; `pytest` без аргументів → 23 помилки збору через дубльований пакет `bobsmoke_full_project/tests`.

| Рівень | Проблема | Де |
|---|---|---|
| **HIGH** | Локальна MongoDB з `docker-compose`/`.env.example` не підключається: `tlsCAFile` неявно вмикає TLS (`ConfigurationError`/`SSL handshake failed`). **Виправлено в цьому аудиті** (TLS лише для `mongodb+srv://` або `tls=true`). | `backend/database.py:20-21` |
| **HIGH** | Англійський текст у UI: «Hot» (бейджі/сортування/aria), «Username», «OFFICIAL», «BOB SMOKE», «Telegram Mini App», типова назва «Shop» (`document.title`, Профіль, Про магазин), «Pod-системи»; адмінка: «Admin», «Hot», «Mini App», «Bob Smoke \| OPT», «username». | `app.js:68,74,196,509,526,724,1024,1036,8`; `data.js:7`; `routes/shop.py:86`; `catalog.py:13`; `admin/index.html:30,45,50,75,91,137,199,269`; `admin.js:81,105,615` |
| **HIGH** | Нативні `confirm()`/`prompt()` в адмінці (мова/вигляд браузера). | `admin.js:316,386,451,540,646,692,855,922,952` |
| **HIGH** | Material Symbols з `display=block`: без шрифту на головній видно `arrow_forward`, `shopping_bag`, `bolt`, `swipe`… | `index.html:11`, `app.js:107,208,224,230` |
| **HIGH** | Два різні логотипи (жовте кільце `logo.jpg` проти лаймового `logo.png`). | `app.js:206,1023` |
| **MEDIUM** | Секції «Новинки»/«Популярні» та бейджі «Новинка»/«Хіт» ніколи не з’являються (`isNew/isPopular` завжди false). | `catalog.py:131`, `app.js:71-73,173-174` |
| **MEDIUM** | 5 застарілих тестів (очікують заблоковані рідини, інший порядок DM у чаті, мінімум 2100, відсутній канал). | `tests/test_catalog.py:33,47`, `test_chat.py:51`, `test_shop_api.py:107`, `test_shop_bot.py:31` |
| **MEDIUM** | `GET /api/chats/{id}` повертає **найстаріші** 500 повідомлень. | `routes/chats.py:37` |
| **MEDIUM** | Пошук користувачів фільтрує після `limit` (старі користувачі не знаходяться). | `routes/users.py:21,32` |
| **MEDIUM** | Інтервали polling в адмінці накопичуються після повторного логіну; будь‑яка помилка `start()` стирає токен. | `admin.js:715,721` |
| **MEDIUM** | `ordersCache` не оновлюється протягом сесії → застарілі статуси. | `app.js:654` |
| **MEDIUM** | Неекрановані `c.title/c.sub` (налаштовує адмін) у `innerHTML`. | `app.js:492,526,566` |
| **MEDIUM** | `product()` падає, якщо категорія товару не з 4 відомих (`c` undefined). | `app.js:516-526` |
| **MEDIUM** | `PUT /api/pricing/markups` → 500 при нечисловому значенні; вебхук → 500 при не‑ASCII заголовку. | `schemas.py:84`, `routes/telegram.py:18` |
| **MEDIUM** | Мобільна таблиця товарів адмінки: опт і роздріб у одній клітинці сітки. | `admin.css:100`, `admin.js:84-85` |
| **LOW** | Мертвий код: `gate()`/`#gate`, `hcard`, `row`, `.logo/.slogan/.agree/.hcard/.rank`, Anton, `SHOW_BLOCKED`, `prepay_accepted`, `/api/bot/cart`, `backend/banner.jpg`, `promo-referral.patch`, `bobsmoke_full_project/`, дубль `backend/render.yaml`. | — |
| **LOW** | Непослідовна копія: «Гурт» проти «Опт», «1‑2 дні» проти «1–3 діб», два види апострофа. | `app.js:109,731,1031` |
| **LOW** | 404 на `/img/*` отримує `immutable` на 7 днів; каталог не інвалідується після імпорту (до 60 с). | `main.py:71`, `routes/imports.py` |
| **LOW** | `/openapi.json` публічний; lockout лише по логіну (перелік користувачів за таймінгом/429). | `main.py:59`, `auth/security.py` |

---

## 11. Проблеми продуктивності

- **Mini App:** three.js (~167 КБ gzip) + `logo.png` 303 КБ для декоративної монети; 17‑шарова CSS‑монета з вічним rAF; 3 безперервні анімаційні цикли на головній; 19 `backdrop-filter` (у т.ч. на кожному серці картки); каталог рендерить усі товари одразу; пошук без дебаунсу; блокуючі `<link>` на 4 сімейства Google Fonts + іконковий шрифт; `pointermove`‑tilt без rAF.
- **Бекенд:** синхронні Pillow/Mongo у `async def` (`routes/media.py`, `broadcast.py`, `imports.py`) блокують єдиний воркер; повні скани у `/api/products?line=`, `/api/lines`, `/api/pricing/markups`; N+1 у `/api/users` (кошики) і `/api/chats`; відсутні індекси `orders.created_at`, `users.last_seen_at`; блокуючий `getChatMember` на кожен запит для користувачів без позитивного кешу; `sync/upload` читає до 60 МБ у пам’ять; каталог кешується 60 с лише в процесі.

---

## 12. Технічні ризики

1. **Юридичний:** `imports/import_report.md` («Юридичний стоп») маркує всі 589 рідин як `blocked_by_law`, але compliance‑гейт у коді вимкнено й усі товари можна замовити. Рішення — за власником; редизайн цього не змінює.
2. **`MINIAPP_DEV_MODE=1`** повністю вимикає авторизацію Mini App — не вмикати на Render.
3. **Витік токена бота** в текстах помилок `requests` (`telegram_api.py`), які пересилаються операторам/адміну.
4. **Втрата реферальних винагород** при видаленні користувача (`user_sync.remove_user`) та при збої після встановлення прапорця.
5. **Без ідемпотентності** `POST /orders` і неатомарний ліміт за годину.
6. **Необмежені переходи статусів** замовлень; `promo/check` і `np/*` без тротлінгу (підбір коротких кодів).
7. **Незакріплені залежності** (`>=`): майбутні мажорні зміни FastAPI/pydantic/Pillow можуть зламати деплой.
8. **Фронтенд без збірки** — будь‑який bundler потребує Node на Render або комітів артефактів. Для редизайну обрано zero‑build підхід.
9. **Локальний запуск із продакшн `BOT_TOKEN` + `PUBLIC_URL` перехопить вебхук живого бота** (`setup_webhook` при кожному старті).

---

## 13. Компоненти, придатні до повторного використання

- **Логіка Mini App (зберігається без змін або з мінімальними правками):** `api.js` (транспорт, мапінг помилок, `subscribe_required`), `data.js` (`loadCatalog`, `applyMode`), `store.js` (кошик/обране/профіль/режим, `pruneCart`, синк кошика), у `app.js`: `route/go/back/stack/scrollPos`, `discInfo/payTotal/minOrder/belowMin`, `phoneOk/coReady`, `loadCities/loadWh/npSeq`, `applyPromo`, `submitOrder` (payload), `fetchOrders/fetchRef`, `copyText/legacyCopy`, `me()`, `chooseMode/pickModeAtStart`, `showSubGate`, `boot`, делегування `data-*`.
- **Адмінка:** `api()`, `toast`, форматери (`money, fmtDate, fmtDt, ago`), `bcRender` (санітайзер), уся бізнес‑логіка вкладок (`loadProducts, renderOrders, renderLines, planPrices, sync‑панель, chats polling, broadcast`), ідентифікатори полів форм (контракт із JS).
- **Бренд‑активи:** `img/logo.png` (лаймове кільце, 512 px) — канонічний аватар; `admin/img/banner.webp`; палітра `#06070a / #0a0a0c / #f3f4ee / #c6ff3d (#c8ff3d) / #172000 / #8b8f84 / #ff6b6b / #ff5a1f→#ffb020`.

## 14. Компоненти, що потребують заміни

- Уся візуальна система Mini App (`styles.css`, розмітка всіх екранів у `app.js`, `index.html`): дві конфліктні дизайн‑системи, 3D‑ефекти, іконковий шрифт, three.js, гейт режиму, тост, скелетони/порожні стани.
- Уся візуальна система адмінки (`admin.css` — 4 нашаровані теми; `index.html` — структура з вкладками у хедері, прихованими «Розсилка/Налаштування»; нативні діалоги; мобільні таблиці).
- Іконки: єдиний набір inline‑SVG (lucide‑стиль) замість 4 систем.
- Логотип: єдиний файл (лаймове кільце) в обох застосунках.

## 15. Рекомендації

1. **Zero‑build редизайн** (vanilla CSS + ES‑modules): сумісно з Render (`pip install` → `uvicorn`), без змін деплою, без нових залежностей; сучасні можливості CSS (custom properties, `color-mix`, container/`dvh`, `scroll-snap`, View Transitions за наявності) і Web Animations API замість three.js.
2. Прибрати three.js, Material Symbols, Inter Tight; лишити Inter (текст) + одне дисплейне сімейство; `font-display: swap`.
3. Єдина дизайн‑система (токени, компоненти, стани) для Mini App і адмінки з брендовою палітрою.
4. Повністю українська локалізація (усунути «Hot», «Shop», «Username», «OFFICIAL», «Admin», «Mini App», нативні діалоги).
5. Мінімальні безпечні правки бекенду: `database.py` (TLS, виконано), типова назва магазину «Bob Smoke», підпис категорії «Под‑системи», `pytest.ini` з ігноруванням `bobsmoke_full_project`.
6. Поза межами редизайну (для власника): compliance‑гейт, пін залежностей, індекси, тротлінг `promo/check`, порядок повідомлень у чаті, атомарний ліміт замовлень, витік токена в помилках.
