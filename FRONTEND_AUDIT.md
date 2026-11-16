# FRONTEND_AUDIT.md — Повний аудит frontend НАВС

Дата: 16.11.2026 · Гілка: `main` · Коміт: `4ae3eb8`

## Skills, використані в цьому аудиті

| Skill | Прочитані інструкції | Застосовані правила | Змінені файли |
|-------|---------------------|---------------------|---------------|
| `web-design-guidelines` | Full Vercel Web Interface Guidelines (15 категорій, 60+ правил) | Accessible, Focus States, Forms, Animation, Typography, Content Handling, Touch & Interaction, Dark Mode, Anti-patterns | `app.js`, `admin.js`, `admin_navs.js`, `progress.js`, `style.css`, `index.html` |
| `frontend-design` | Design principles, typography, restraint, copywriting | Design restraint, active-voice copy, specific labels, empty states, type scale review | `style.css`, `index.html`, `progress.js` |

### Конкретні приклади «правило → проблема → виправлення»

**1. `outline: none` без заміни focus (Anti-pattern)**
- Проблема: `style.css:253` — `.field` мав `outline: none;` без `:focus-visible` заміни.
- Правило: "Never `outline-none` / `outline: none` without focus replacement"
- Виправлення: видалив `outline: none`, додав `.field:focus-visible`

**2. Модальні вікна без ESC / focus trap (Accessibility)**
- Проблема: `app.js` — `openSheet()` не ловив `Escape`, не переміщував focus в діалог, не повертав focus після закриття.
- Правило: "Interactive elements need keyboard handlers"
- Виправлення: `document.addEventListener('keydown')` → `Escape` закриває, `Tab`/`Shift+Tab` trap focus, `openSheet` фокусує перший елемент, `closeAllSheets` повертає focus.

**3. Динамічні повідомлення без `aria-live` (Accessibility)**
- Проблема: `data-role="msg"` та `data-role="err"` в `app.js`, `admin.js`, `progress.js` оновлюються асинхронно без `aria-live`.
- Правило: "Async updates need `aria-live='polite'`"
- Виправлення: `aria-live="polite"` на всі `data-role="msg"`, `aria-live="assertive"` на `data-role="err"`

**4. Toast без `aria-live`**
- Виправлення: `#toast` отримав `role="status" aria-live="polite"`.

**5. Бандер «Сервер прокидається» без `aria-live`**
- Виправлення: `role="alert" aria-live="assertive"`.

**6. Skip link (Accessibility)**
- Правило: "include skip link for main content"
- Виправлення: `<a href="#app" class="skip-link">` в `index.html` + прихований CSS-стиль.

**7. `overscroll-behavior` на модалках**
- Виправлення: `overscroll-behavior: contain` на `.overlay` і `.sheet`.

**8. `prefers-reduced-motion` (Animation)**
- Виправлення: розширено `@media (prefers-reduced-motion: reduce)` — `shimmer`, `rise`, `fade`, `spin`, hover-трансформації.

**9. `select.field` без явного `background-color`/`color` (Dark Mode, Windows)**
- Виправлення: `background-color: var(--surface); color: var(--text);`

**10. `...` → `…` в user-facing copy (Typography)**
- Виправлення: `admin_navs.js` placeholder `...` → `…`

**11. Декоративні SVG без `aria-hidden` (Accessibility)**
- Перевірено: `ic()` в `app.js:131` вже генерує `aria-hidden="true"` — OK.

**12. `touch-action` (Touch & Interaction)**
- Перевірено: глобально `button` ма�� `touch-action: manipulation`, явний `.pass-toggle-btn`, `.btn`, `.link`, `.tab` додавано в `style.css`.

## Файли, що перевірені

| Файл | Статус | Коментарі |
|------|--------|----------|
| `public/index.html` | ✅ Виправлено | skip-link, `role="alert"` banner, `role="status"` toast |
| `public/app.js` | ✅ Виправлено | modal a11y, `aria-live` msg/err, login form a11y |
| `public/admin.js` | ✅ Виправлено | `aria-live` × 6 |
| `public/admin_navs.js` | ✅ Виправлено | `…` замість `...` |
| `public/progress.js` | ✅ Виправлено | `aria-live` msg/err, security section |
| `public/style.css` | ✅ Виправлено | `focus-visible`, `reduced-motion`, `overscroll`, skip-link, `select` dark mode |
| `public/charts.js` | ✅ OK | `role="img" aria-label` на placeholders |
| `public/device.js` | ✅ OK | без UI-елементів |
| `public/schedule.js` | ✅ OK | парсер, без UI |
| `public/rating.js` | ✅ OK | парсер, без UI |
| `public/theme.js` | ✅ OK | |
| `public/sw.js` | ✅ OK | |

## Результати тестування

- `npm test` — **44/44 passed**
- `node --check` — синтаксис всіх `.js` в `public/` — **OK**
- CSS — ручний огляд, без помилок синтаксису

## Проблеми, що залишилися (НЕ виправлено)

1. **Контрастність `--faint` в темній темі** — `#636b7e` на `#141821` ≈ 3.2:1, нижче WCAG AA 4.5:1. Потребує ручного коригування.
2. **`loading="lazy"`** не застосовано до image в homework attachments.
3. **`scroll-margin-top`** на anchor-заголовках — не є критичним.
4. **Таблиці `admin/students` без `caption`** — `<table>` без доступного заголовка.

## Перевірки, які НЕ виконано

| Перевірка | Причина |
|-----------|--------|
| Візуальний тест у реальному браузері | Немає доступу до браузерного середовища |
| Test за допомогою screen reader | Не є частиною CI-окруження |
| HTML lint (tidy/htmlhint) | Не встановлений в проєкті |
| Перевірка контрастності (WCAG AA 4.5:1) | Потребує візуального інструменту |
| Повна адаптивність (320px/768px/1024px/1440px) | Не має браузерного тесту |
| PWA install/manifest в реальному браузері | Не доступний інструмент |

