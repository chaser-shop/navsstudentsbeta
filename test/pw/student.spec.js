'use strict';
/*
 * Сценарії студента (Playwright, Chromium).
 */

const { test, expect, request, baseUrl, apiLogin, createStudent, openApp, collectErrors } = require('./helpers');

const ADMIN_NAME = process.env.PW_ADMIN_NAME || 'Адміністраторенко Адмін Адмінович';
const DEVICE = 'pw-student-dev-1';

async function adminToken(req) {
  const r = await apiLogin(req, { fullName: ADMIN_NAME, deviceId: 'pw-admin-dev' });
  if (r.status !== 200) throw new Error(`admin login failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
}

/** Змінює тимчасовий пароль через API (щоб студент отримав повний доступ до застосунку). */
async function changeTempPassword(req, st, deviceId = DEVICE) {
  // Спочатку вхід тимчасовим паролем, щоб отримати токен.
  const lg = await apiLogin(req, { login: st.login, password: st.tempPassword, group: '201 СПД', deviceId });
  if (lg.status !== 200) throw new Error(`temp login failed: ${lg.status}`);
  const ch = await req.post('/api/auth/change-password', {
    data: { newPassword: 'ChPwd99xyz', confirmPassword: 'ChPwd99xyz' },
    headers: { Authorization: `Bearer ${lg.data.token}`, 'X-Device-Id': deviceId },
  });
  if (ch.status() !== 200) throw new Error(`change password failed: ${ch.status()}`);
  st.newPassword = 'ChPwd99xyz';
  return st;
}
async function ensureGroup(req, name, course = 1) {
  const tok = await adminToken(req);
  const res = await req.post('/api/admin/groups-full', {
    data: { name, course, faculty: 'ННІ №1' },
    headers: { Authorization: `Bearer ${tok}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  if (![200, 409].includes(res.status())) {
    throw new Error(`ensure group ${name} failed: ${res.status()} ${await res.text().catch(() => '')}`);
  }
}

async function freshStudent(req, group = '201 СПД') {
  await ensureGroup(req, group);
  return createStudent(await adminToken(req), req, { fullName: `ПІБ Тест ${Date.now() % 100000}`, group, role: 'student' });
}

test('S1. Відкриття сторінки входу + емблема НАВС + список груп', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto(baseUrl());
  await expect(page.locator('img.navs-crest')).toBeVisible();
  const groupSel = page.locator('#loginGroup');
  await expect(groupSel).toBeVisible();
  const opts = await groupSel.locator('option').allTextContents();
  expect(opts.length, 'group options loaded').toBeGreaterThan(0);
  const critical = errs.filter((e) => e.startsWith('http5xx') || e.startsWith('pageerror'));
  expect(critical, 'no 5xx/page errors on login').toEqual([]);
});

/** Чекає, поки у випадаючому списку груп на сторінці входу з'явиться група `name`.
 * Опції <option> не мають стану "visible" у DOM (приховані, доки <select> не відкрито),
 * тому очікуємо на state 'attached'. */
async function waitGroupOption(page, name) {
  await page.waitForSelector('#loginGroup option', { state: 'attached', timeout: 15000 });
  const present = await page.locator(`#loginGroup option[value="${name}"]`).count();
  if (present > 0) return;
  // loadNavsGroups оновлює select асинхронно — чекаємо появи нужної опції.
  await page.waitForSelector(`#loginGroup option[value="${name}"]`, { state: 'attached', timeout: 15000 });
}

test('S2. Вхід з неправильним паролем відхиляється', async ({ page, request }) => {
  const st = await freshStudent(request);
  await page.goto(baseUrl());
  await waitGroupOption(page, '201 СПД');
  await page.fill('#loginUser', st.login);
  await page.fill('#loginPass', 'WrongPassword1');
  await page.selectOption('#loginGroup', '201 СПД');
  await page.click('#loginBtn');
  // Чекаємо, поки сервер відповість і повідомлення про помилку з'явиться.
  const errEl = page.locator('#loginErr');
  await expect(errEl).not.toHaveText('', { timeout: 10000 });
  const err = await errEl.textContent();
  expect(err, 'login error shown').toMatch(/невірний|пароль/i);
  const tok = await page.evaluate(() => localStorage.getItem('token'));
  expect(tok, 'no token on failed login').toBeFalsy();
});

test('S3. Правильний вхід + примусова зміна пароля', async ({ page, request }) => {
  const st = await freshStudent(request);
  await page.goto(baseUrl());
  await waitGroupOption(page, '201 СПД');
  await page.fill('#loginUser', st.login);
  await page.fill('#loginPass', st.tempPassword);
  await page.selectOption('#loginGroup', '201 СПД');
  await page.click('#loginBtn');
  await expect(page.locator('#changePassForm')).toBeVisible({ timeout: 10000 });
  await page.fill('#newPass', 'NewSecure123');
  await page.fill('#confirmPass', 'NewSecure123');
  await page.click('#changePassBtn');
  await expect(page.locator('#changePassForm')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('.sb-user')).toBeVisible();
});

test('S4. Головна + профіль + оцінки + розклад', async ({ page, request }) => {
  const st = await freshStudent(request);
  await changeTempPassword(request, st);
  const r = await apiLogin(request, { login: st.login, password: st.newPassword, group: '201 СПД', deviceId: DEVICE });
  expect(r.status, 'student login with changed password').toBe(200);
  await openApp(page, r.data.token);
  await expect(page.locator('.sidebar .sb-user')).toBeVisible({ timeout: 15000 });
  await page.click('.sb-item[data-tab="settings"][data-sub="profile"]');
  await expect(page.locator('main.content')).toBeVisible({ timeout: 10000 });
  await page.click('.sb-item[data-tab="progress"][data-sub="scores"]');
  await expect(page.locator('main.content')).toBeVisible({ timeout: 10000 });
  await page.click('.sb-item[data-tab="schedule"]');
  await expect(page.locator('main.content')).toBeVisible();
});

test('S5. Безпечний вихід + повторний вхід', async ({ page, request }) => {
  const st = await freshStudent(request);
  await changeTempPassword(request, st);
  const r = await apiLogin(request, { login: st.login, password: st.newPassword, group: '201 СПД', deviceId: DEVICE });
  await openApp(page, r.data.token);
  await expect(page.locator('.sb-user')).toBeVisible({ timeout: 15000 });
  const lo = await page.request.post('/api/auth/logout');
  expect(lo.status(), 'logout 200').toBe(200);
  const me = await page.request.get('/api/me/scores', { headers: { Authorization: `Bearer ${r.data.token}`, 'X-Device-Id': DEVICE } });
  expect([401, 403]).toContain(me.status(), `stale session rejected (${me.status()})`);
});

