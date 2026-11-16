'use strict';
/* Тимчасовий репро: чи працює кнопка «Вхід за прізвищем» і чи з'являється поле ПІБ.
 * Запуск: npx playwright test test/pw/_loginrepro.spec.js --project=chromium:desktop-1280 */

const { test, expect, request, baseUrl } = require('./helpers');

test('L. Кнопка «Вхід за прізвищем» відкриває поле ПІБ + вхід за логіном', async ({ page, request }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  // 1. Спочатку режим navs (логін/пароль)
  await expect(page.locator('#loginForm')).toBeVisible({ timeout: 20000 });
  const loginToggle = page.locator('[data-act="loginModeLegacy"]');
  expect(await loginToggle.count(), 'toggle button exists').toBe(1);
  await loginToggle.click();

  // 2. Після кліку має з'явитись поле ПІБ (legacy режим)
  const full = page.locator('#fullName');
  await expect(full).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: '/tmp/repro-legacy.png' });

  // 3. Повертаємось у режим логіна
  await page.locator('[data-act="loginModeNavs"]').click();
  await expect(page.locator('#loginUser')).toBeVisible({ timeout: 8000 });
  await page.screenshot({ path: '/tmp/repro-navs.png' });

  const critical = errs.filter((e) => e.startsWith('pageerror') || e.includes('500') || e.includes('ReferenceError'));
  expect(critical, 'no JS errors: ' + JSON.stringify(errs)).toEqual([]);
});
