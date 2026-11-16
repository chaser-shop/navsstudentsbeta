'use strict';
/*
 * Мобільний + viewport-аудит + базова accessibility (axe).
 */

const { test, expect, request, baseUrl, apiLogin, createStudent, openApp, collectErrors } = require('./helpers');
const { AxeBuilder } = require('@axe-core/playwright');

const ADMIN_NAME = process.env.PW_ADMIN_NAME || 'Адміністраторенко Адмін Адмінович';

test('M1. Мобільний viewport: без горизонтального прокруту, емблема видима', async ({ page }) => {
  await page.goto(baseUrl());
  await expect(page.locator('img.navs-crest')).toBeVisible();
  await expect(page.locator('#loginForm')).toBeVisible();
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'no horizontal overflow (scrollWidth <= clientWidth)').toBeLessThanOrEqual(clientWidth + 2);
});

test('M2. Доступність логін-форми (axe, без критичних порушень)', async ({ page }) => {
  await page.goto(baseUrl());
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const critical = results.violations.filter((v) => v.impact === 'critical');
  expect(critical.map((v) => `${v.id}: ${v.nodes.length} node(s)`), 'no critical axe on login').toEqual([]);
});

test('M3. Доступність головної сторінки після входу', async ({ page, request }) => {
  const r = await apiLogin(request, { fullName: ADMIN_NAME, deviceId: 'pw-a11y-dev' });
  expect(r.status).toBe(200);
  await openApp(page, r.data.token);
  await expect(page.locator('.sb-user')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const critical = results.violations.filter((v) => v.impact === 'critical');
  expect(critical.map((v) => `${v.id}: ${v.nodes.length} node(s)`), 'no critical a11y on home').toEqual([]);
});

