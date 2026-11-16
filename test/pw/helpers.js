'use strict';
/*
 * Спільний хелпер для Playwright-тестів НАВС.
 * - apiLogin (Request-фіктура, без браузера) для API-операцій.
 * - openApp (Page) для відображення інтерфейсу.
 * - collectErrors (Page) для збору console/JS/network помилок.
 */

const { test, expect, request } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

function baseUrl() {
  const b = process.env.PW_BASE_URL;
  if (b) return b;
  // Fallback: мета-файл, записаний у globalSetup (надійніше за process.env між процесами).
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pw-meta.json'), 'utf8'));
    return meta.baseUrl;
  } catch {
    throw new Error('PW_BASE_URL not set and pw-meta.json missing — was globalSetup run?');
  }
}

/** Логін через API (Request, без браузера). */
async function apiLogin(req, body) {
  const res = await req.post('/api/auth/login', { data: body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status(), data };
}

/**
 * Створює студента через адмін-API.
 * `adminDevice` — X-Device-Id, що відповідає адмін-токену (має збігатися з deviceId,
 * за яким було підписано токен, інакше сервер відповість 401 «Сеанс не належить цьому
 * пристрою» — див. серверна перевірка data.d === headerDevice).
 */
async function createStudent(adminTok, req, { fullName, group, role = 'student', adminDevice = 'pw-admin-dev' }) {
  const res = await req.post('/api/admin/members', {
    data: { fullName, group, role },
    headers: { Authorization: `Bearer ${adminTok}`, 'X-Device-Id': adminDevice },
  });
  expect(res.status(), 'create member').toBe(200);
  const data = await res.json();
  return {
    user: data.user,
    login: data.credentials.login,
    tempPassword: data.credentials.tempPassword,
  };
}

/** Переходить на сторінку з авторизованим токеном.
 * `dev` — X-Device-Id, за яким підписано токен; встановлюємо його в localStorage,
 * щоб браузерний запит (X-Device-Id) збігався з пристроєм токена (інакше сервер
 * відповість 401 «Сеанс не належить цьому пристрою»). Значення JSON.stringify,
 * бо застосунок читає їх через LS.get (JSON.parse).
 * Також автоматично прибирає модальне вікно Web Push (#pushAsk), якщо воно з'являється,
 * щоб наступні кліки по UI не перехоплювались. */
async function openApp(page, token, dev = 'pw-student-dev-1') {
  await page.goto('/');
  await page.evaluate((o) => {
    localStorage.setItem('token', JSON.stringify(o.token));
    localStorage.setItem('deviceId', JSON.stringify(o.dev));
  }, { token, dev });
  await page.reload();
  await page.waitForSelector('#loginForm, #changePassForm', { state: 'attached', timeout: 20000 }).catch(() => {});
  // Чекаємо авторизований інтерфейс (вмісно: сайдбар на десктопці, tabbar на мобільному).
  await expectAuthenticated(page, 20000);
  // Модальне запитує про Web Push з'являється після sync(); прибираємо його.
  await dismissPushAsk(page);
}

/** Збирає console errors, pageerror і failed-запити. */
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/')) errors.push(`requestfailed: ${req.method()} ${req.url()}`);
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/') && res.status() >= 500) errors.push(`http5xx: ${res.status()} ${res.url()}`);
  });
  return errors;
}

/** Прибирає модальне запрошення про Web Push (#pushAsk), яке блокує кліки по UI.
 * Вікно з'являється асинхронно після завершення sync(), тому чекаємо його
 * появи (якщо воно взагалі показується у цьому середовищі) і натискаємо
 * кнопку «Зрозуміло»/«Не зараз» (data-act="pushLater"). Не вмикає сповіщення —
 * лише ховає запрошення до наступного заходу (оригінальна поведінка pushLater).
 * force: true не використовуємо — натискаємо реальну видиму кнопку. */
async function dismissPushAsk(page, opts = {}) {
  const timeout = opts.timeout || 8000;
  const box = page.locator('#pushAsk');
  // Чекаємо появи вікна; якщо за timeout його не з'явиться — нічого не робимо
  // (у середовищі, де push вже ввімкнено або не підтримується, вікна взагалі немає).
  try {
    await box.waitFor({ state: 'visible', timeout });
  } catch {
    return; // вікна немає — закривати нічого
  }
  const dismiss = box.locator('[data-act="pushLater"]');
  if (await dismiss.count()) {
    await dismiss.click();
    await box.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
}

/** Чи мобільний режим (сайт приховує сайдбар і показує нижній tabbar). */
function isMobileViewport(page) {
  try {
    const w = page.viewportSize();
    return w && w.width < 900;
  } catch {
    return false;
  }
}

/** Чекає появи авторизованого інтерфейсу (вмісний для desktop/mobile).
 * На десктопце видно сайдбар (.sb-user); на мобільному — нижній tabbar (.tabbar). */
async function expectAuthenticated(page, timeout = 20000) {
  if (isMobileViewport(page)) {
    await expect(page.locator('.tabbar')).toBeVisible({ timeout });
  } else {
    await expect(page.locator('.sidebar .sb-user')).toBeVisible({ timeout });
  }
}

/** Переключає вкладку навігації вмісно:
 * - Десктоп: клікає прямий пункт сайдбару (.sb-item[data-tab][data-sub]) —
 *   він відкриває відповідний підрозділ одразу.
 * - Мобільний: клікає нижню вкладку (.tabbar .tab) і підрозділ у subnav. */
async function navigateTab(page, tab, sub) {
  if (isMobileViewport(page)) {
    await page.click(`.tabbar .tab[data-tab="${tab}"]`);
    if (sub) await page.click(`.subnav button[data-sub="${sub}"]`);
  } else {
    const direct = sub
      ? page.locator(`.sb-item[data-tab="${tab}"][data-sub="${sub}"]`)
      : page.locator(`.sb-item[data-tab="${tab}"]`);
    if (await direct.count()) {
      await direct.first().click();
      return;
    }
    // Резерв: спочатку вкладка в сайдбарі, потім subnav.
    await page.click(`.sb-item[data-tab="${tab}"]`);
    if (sub) await page.click(`.subnav button[data-sub="${sub}"]`);
  }
}

module.exports = { test, expect, request, baseUrl, apiLogin, createStudent, openApp, collectErrors, dismissPushAsk, isMobileViewport, expectAuthenticated, navigateTab };

