# PROGRESS.md — стан редизайну Bob Smoke

Оновлено: 2026‑11‑12. Повний контекст — у `PROJECT_AUDIT.md` (аудит), `REDESIGN_PLAN.md` (план), `ADMIN_AUDIT.md` і `ADMIN_PROGRESS.md` (адмін-панель).

## Виконані фази
- **Фаза 0 — аудит:** виконано. Створено `PROJECT_AUDIT.md`, `REDESIGN_PLAN.md`. Базовий стан тестів зафіксовано (195 passed / 5 застарілих failed).
- **Фаза A — фундамент Mini App:** виконано (`frontend/miniapp/index.html`, `css/styles.css` з нуля, іконки inline‑SVG, шрифти Inter + Manrope, без three.js/Material Symbols).
- **Фаза B — екрани Mini App:** виконано (усі маршрути переписано в `frontend/miniapp/js/app.js`, логіка/API/localStorage збережені).
- **Фаза D — мікроправки бекенду:** виконано (`backend/database.py` TLS, `routes/shop.py` назва «Bob Smoke», `services/catalog.py` «Под‑системи», `pytest.ini`).
- **Фаза C — адмін‑панель:** виконано. Окрім редизайну всіх розділів — огляд із реальною статистикою й графіками, розділ «Аналітика», картки замовлення (історія, нотатки, зміна статусу з підтвердженням) і клієнта, керування категоріями (назва, підпис, фото, націнка) та лінійками (фото, перейменування, видалення), серверний пошук і фільтри. Нові сумісні ендпоінти: `GET /api/stats/overview`, `GET /api/stats/analytics`, `GET /api/users/{tg_id}`; розширено `GET /api/orders`, `GET /api/users`, `GET /api/categories`; виправлено порядок повідомлень у чаті. Деталі — `ADMIN_PROGRESS.md`.
- **Фаза E — QA:** Mini App перевірено в headless‑Chrome (390×844, 1280×800): гейт входу, головна, каталог, категорія (сортування, бренди), товар (варіанти, міцність, степер), пошук, кошик (прогрес знижки, мінімум), оформлення (контакти, місто/відділення НП через мок відповіді, промокод‑помилка, оплата), створення замовлення (реальний `POST /orders` → `ORD-20261112-0001`), «Мої замовлення» + деталі (таймлайн), профіль, допомога, обране, порожні стани, 404, перемикання опт/роздріб. Консоль без помилок (лише попередження Telegram SDK поза Telegram). Адмін-панель перевірено на 1440×900, 1024×768, 768×1024, 390×844 (усі розділи, шухляди, діалоги; 0 помилок консолі), після змін адмінки Mini App повторно відкрито (гейт, головна, каталог — без помилок). `pytest` → 206 passed, 4 failed (ті самі застарілі тести, що падають і на базовому коміті).

## Змінені файли
`PROJECT_AUDIT.md`, `REDESIGN_PLAN.md`, `PROGRESS.md`, `ADMIN_AUDIT.md`, `ADMIN_PROGRESS.md`, `pytest.ini`, `backend/database.py`, `backend/main.py`, `backend/routes/{shop.py, stats.py (новий), users.py, orders.py, chats.py, products.py}`, `backend/services/catalog.py`, `tests/test_admin_stats.py` (новий), `frontend/miniapp/{index.html, README.md, css/styles.css, js/app.js, js/data.js}`; адмінка: `frontend/admin/{index.html, css/admin.css, js/admin.js, js/ui.js}` і нові модулі `js/{charts.js, shared.js, dashboard.js, analytics.js, orders.js, customers.js}`.

## Що лишилося
1. Рішення власника щодо 4 застарілих тестів (оновити очікування або поведінку) і ризиків із `PROJECT_AUDIT.md` (compliance‑гейт, ідемпотентність замовлень тощо).
2. За потреби — опублікувати гілку й PR; перевірити доставку повідомлень із реальним `BOT_TOKEN`.

## Відомі обмеження / не перевірено в пісочниці
- Нова пошта (немає `NOVA_POSHTA_API_KEY`) — перевірено з моком відповідей у браузері; серверний код не змінювався.
- Telegram‑специфіка (haptics, BackButton, initData, гейт підписки, повідомлення/чек покупцю) — не змінювалась, перевірена лише за кодом і наявними тестами.
- 4 застарілі тести (`test_catalog`, `test_chat`, `test_shop_api::min_total`) падали й до редизайну — очікування не відповідають поточним налаштуванням; рішення за власником.

## Як продовжити роботу
1. `docker compose up -d mongo`, `.env` з `MONGODB_URI=mongodb://127.0.0.1:27017`, `JWT_SECRET` (≥32), `MINIAPP_DEV_MODE=1`, `REQUIRED_CHANNEL=off`, `USER_SYNC_HOURS=0`, `KEEPALIVE_SECONDS=0`.
2. `python -m backend.cli create-admin`, `python -m backend.cli import-products --apply`.
3. `uvicorn backend.main:app --port 8000` → http://127.0.0.1:8000/app/ і http://127.0.0.1:8000/admin/.
4. `pytest` (конфіг у `pytest.ini`).
