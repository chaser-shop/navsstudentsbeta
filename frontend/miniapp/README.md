# Telegram Mini App (магазин)

Без збірки й залежностей: чистий HTML/CSS/ES‑модулі. Віддається backend‑ом за адресою `/app/`.

## Файли
- `index.html` — точка входу (мета, шрифти Inter + Manrope, Telegram Web Apps SDK).
- `css/styles.css` — дизайн‑система «Bob Smoke UI»: токени (`--bg`, `--acc`, `--tx`, радіуси, easing) → базові стилі → компоненти (`.btn`, `.chip`, `.seg`, `.pill`, `.card`, `.tile`, `.li`, `.step`, `.sum`, `.pick`, `.stepc`, `.empty`, `.sk`) → екрани → гейти → адаптив.
- `js/api.js` — запити до `/api/shop/*`; кожен несе підписані дані Telegram (`X-Telegram-Init-Data`).
- `js/data.js` — завантаження каталогу з backend (колекція `products` у MongoDB), перерахунок цін для роздрібу (`applyMode`).
- `js/store.js` — кошик, обране, дані покупця, режим опт/роздріб (`localStorage['miniapp_state_v2']`).
- `js/app.js` — роутер (`#/...`), усі екрани, оформлення замовлення з вибором міста й відділення Нової пошти, історія замовлень, реферальна програма, вхідний екран (опт/роздріб + підтвердження 18+).

Іконки — inline SVG (без іконкових шрифтів). Фото беруться з `/img/<файл>`; для товарів без фото малюється ілюстрація за категорією. Аватар магазину — `img/logo.png`.

## Маршрути
`#/home`, `#/catalog`, `#/catalog/:cat`, `#/search`, `#/cart`, `#/checkout`, `#/product/:id`, `#/profile`, `#/profile/orders[/:number]`, `#/profile/favs`, `#/profile/invite`, `#/profile/info`, `#/profile/help`, `#/profile/about`.

## Локально без Telegram
У `.env` задайте `MINIAPP_DEV_MODE=1`, запустіть `uvicorn backend.main:app --port 8000` і відкрийте http://127.0.0.1:8000/app/.
Без цього прапорця сервер приймає лише запити, підписані Telegram. Пошук міст/відділень потребує `NOVA_POSHTA_API_KEY`.
