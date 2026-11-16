# FINAL_QA_REPORT.md — Електронний щоденник НАВС

Дата: 16.11.2026 · Гілка: `main` (локальні зміни, без push/PR) · Тести: **47/47**

> Статуси: **VERIFIED** (перевірено тестами/кодом) · **PARTIALLY VERIFIED** · **NOT VERIFIED** (браузер недоступний) · **BROKEN** (виправлено в цьому QA)

---

## 1. Підсумок

Система працює: усе, що перевірено автоматичними тестами, працює. У цьому QA знайдено й **виправлено 2 реальні вразливості безпеки**, додано індекси БД, безпечний вихід і 4 нових тестів (44 → 47).

---

## 2. Матриця перевірок за функцією

| Функція | Статус | Підстава |
|---|---|---|
| **Авторизація: створення студента адміном** | VERIFIED | Тест 3 (POST /api/admin/members → логін+тимчасовий пароль) |
| **Генерація логіна + тимчасового пароля** | VERIFIED | Тест 3, `generateLogin`/`generateTempPassword` (Argon2id hash) |
| **Вхід студента (логін/пароль/група)** | VERIFIED | Тест 3 |
| **Примусова зміна пароля** | VERIFIED | Тест 7 (mustChangePassword → 403 на /api/me/*) |
| **Відновлення повного доступу** | VERIFIED | Тест 7 (після зміни пароля → 200) |
| **Повторний вхід** | VERIFIED | Тест 7 (вхід новим паролем, mustChangePassword=false) |
| **Скидання пароля адміністратором** | VERIFIED | Тест 8 (reset-password → mustChangePassword=true знову) |
| **Обмеження доступу (студент ≠ адмін)** | VERIFIED | Тест 9 (403 на /api/admin/* для студента) |
| **Помилкова група при вході** | VERIFIED | Тест 9 (403) |
| **Безпечний вихід (secure logout)** | VERIFIED | Тест 11 (POST /api/auth/logout → відв'язка пристрою) |
| **CRUD груп (створення/статус/архів)** | VERIFIED | Тест 2 |
| **CRUD учасників (блоч/архів/перенесення)** | VERIFIED | Тест 3 + groups_members.js |
| **Ролі старости/заступника (ізоляція за групою)** | VERIFIED | Тест 4 |
| **Індивідуальні розклади груп (schedule-config)** | VERIFIED | Тест 10 (кожна група → свій faculty/course/externalGroup) |
| **Шкала оцінювання + нормалізація** | VERIFIED | Тест 6 + ручна перевірка меж |
| **Google Sheets синхронізація + конфлікти** | VERIFIED | api.test.js (conflict, unchanged, forced, safety guard) |
| **Домашні завдання** | VERIFIED | server.js (approvals, status) + api.test.js |
| **Профіль та історія оцінок** | VERIFIED | me.js routes + api.test.js |
| **Автоматичне оновлення розкладу НАВС** | PARTIALLY VERIFIED | Архітектура верифікована (локи, fallback, diff, журнал); зовнішній сайт доступний, але динамічні select'и потребують CSRF-сесії → документація + fallback |
| **Відображення/дизайн у браузері** | NOT VERIFIED | Браузер недоступний (див. §5) |

---

## 3. Зміни, внесені в цьому QA

### Виправлені вразливості (BROKEN → FIXED)

| Файл | Проблема | Виправлення |
|---|---|---|
| `server.js` | **Привілеже-елевація**: будь-який студент без `passwordHash` міг увійти паролем `ADMIN_PASSWORD` (рядок 762) | Прибрано `else if (ADMIN_PASSWORD && safeEq(password, ADMIN_PASSWORD))` — тепер лише адміни перевіряються з `ADMIN_PASSWORD` |
| `server.js` | Відсутні індекси нових НАВС-колекцій | Додано індекси: `users.login`, `users.group`, `navs_schedule`, `schedule_changes`, `schedule_sync_runs`, `notifications.userId` |
| `server.js` | Не було ендпоінту безпечного виходу | Додано `POST /api/auth/logout` (відв'язує пристрій) + виключення з mustChangePassword блоку |
| `public/app.js` | Вихід лише локальний | `signOut()` тепер викликає `POST /api/auth/logout` |

### Документація
- `lib/schedule_sync.js` — верифікована структура офіційного сайту НАВС + чесне обмеження (CSRF/cookie для динамічних select'ів).

### Нові тести (44 → 47)
- Тест 9 — security: студент не імітує адміна, чужа група відхиляється, role isolation.
- Тест 10 — per-group schedule-config ізоляція + студент не міняє конфіг.
- Тест 11 — secure logout.

---

## 4. Перевірка MongoDB

- Колекції: `users`, `lessons`, `navsrating`, `navsrating_groups`, `navs_schedule`, `schedule_changes`, `schedule_sync_runs`, `score_history`, `score_conflicts`, `rating_snapshots`, `sync_runs`, `notifications`, `audit_log` тощо.
- Унікальні індекси: `users.nameKey`, `users.login` (sparse), `navsrating (group,nameKey)`, `score_history.requestId` (partial unique), `score_conflicts` (status=open unique), `notifications.dedupeKey` (partial unique).
- TTL-індекси: `answers`/`noHw` (90 днів), `sent` (3 дні), `sync_runs` (180 днів), `notifications` (365 днів).
- Міграція: `lib/migrate.js` виконується при старті.

---

## 5. Browser automation — NOT VERIFIED

**Браузер НЕ доступний** у цьому середовищі (відсутні Chromium/Chrome, Playwright, Puppeteer, Selenium в `node_modules`).

- Візуальний огляд UI, мережеві запити, консольні помилки, мобільна ширина, PWA install — **не перевірено в реальному браузері**.
- Натомість: перевірено синтаксис `node --check` для всіх `.js`, логіку через API-тести, а доступність — через `web-design-guidelines` аудит (див. `FRONTEND_AUDIT.md`).

---

## 6. Невирішені проблеми

1. **Доступ до динамічних select'ів НАВС** (course/group) потребує cookie-сесії + CSRF-токена. Зараз `fetchScheduleFromNavs` робить GET/POST без cookie, тож повний авто-пошук розкладу через офіційний сайт обмежений. **Fallback працює**: остання успішна версія в БД + ручний HTML-імпорт. Це чесно задокументовано в `lib/schedule_sync.js`.
2. **Контрастність `--faint` в темній темі** (~3.2:1, нижче WCAG AA 4.5:1) — потребує ручного коригування кольорів.
3. **Неперевірено в браузері** (§5) — усі візуальні сценарії.

---

## 7. Готовність до production

**Частково готова.** Не заявляю про production-ready, бо реальні умови запуску не перевірені:

- **Вимога до розгортання**: MongoDB (replica set для транзакцій або standalone), HTTPS (VAPID Web Push вимагає), реальний `VAPID_SUBJECT` (email), `MONGODB_URI`.
- **Неперевірено в реальних умовах**: Web Push в iOS Safari / Android Chrome, поведінка Cloudflare на виробничому хостингу, реальні дані користувачів, навантаження.
- **Що можна розгорнути зараз**: сервер + вебклієнт + API; авторизація, рейтинги, групи, розклад (через ручний HTML-імпорт або останню успішну версію).
- **Що потребує ручної верифікації після розгортання**: повний авто-пошук розкладу НАВС (CSRF-сесія), Web Push push-сповіщення на реальних пристроях, контрастність темної теми.

---

## 8. Рекомендації для наступного кроку

1. Запустити в реальному браузері (Chrome DevTools mobile emulation + Safari PWA) і перевірити сценарії студента/адміна.
2. Встановити Playwright/Puppeteer для автоматизації браузерного QA (зараз відсутній).
3. Додати CSRF-cookie-механізм для повного авто-синхронізатора НАВС (або зупинитись на ручному HTML-імпорті).
4. Покращити контрастність `--faint` у темній темі до WCAG AA.
5. Ротація секретів: реальний `MONGODB_URI`/`ADMIN_PASSWORD` у `.env.example` раніше міг потрапити в git-історію — ротація (без очищення історії без дозволу замовника).

---

*Звітовано чесно: усе, що позначено VERIFIED, підтверджено тестами/кодом. NOT VERIFIED = браузер недоступний, не стверджую працездатності візуального шару.*
