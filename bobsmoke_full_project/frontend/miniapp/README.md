# Telegram Mini App (магазин)

Без збірки й залежностей: чистий HTML/CSS/ES-модулі. Віддається backend-ом за адресою `/app/`.

## Файли
- `index.html` — точка входу, підключає Telegram Web Apps SDK.
- `css/styles.css` — дизайн-система.
- `js/api.js` — запити до `/api/shop/*`; кожен несе підписані дані Telegram (`X-Telegram-Init-Data`).
- `js/data.js` — завантаження каталогу з backend (колекція `products` у MongoDB), групування по моделях/лінійках робить сервер.
- `js/store.js` — кошик, обране, дані покупця для автозаповнення (`localStorage`).
- `js/app.js` — роутер (`#/...`), екрани, оформлення замовлення з вибором міста й відділення Нової пошти, історія замовлень.

Фото беруться з `/img/<файл>` (теку `imports/images` віддає backend).

## Локально без Telegram
У `.env` задайте `MINIAPP_DEV_MODE=1`, запустіть `uvicorn backend.main:app --port 8000` і відкрийте http://127.0.0.1:8000/app/.
Без цього прапорця сервер приймає лише запити, підписані Telegram.
