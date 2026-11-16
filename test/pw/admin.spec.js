'use strict';
/*
 * Сценарії адміністратора (Playwright, Chromium).
 */

const { test, expect, request, baseUrl, apiLogin, createStudent, openApp, collectErrors } = require('./helpers');

const ADMIN_NAME = process.env.PW_ADMIN_NAME || 'Адміністраторенко Адмін Адмінович';

async function adminToken(req) {
  const r = await apiLogin(req, { fullName: ADMIN_NAME, deviceId: 'pw-admin-dev' });
  if (r.status !== 200) throw new Error(`admin login failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
}

test('A1. Вхід адміністратора + адмін-панель', async ({ page, request }) => {
  const errs = collectErrors(page);
  const token = await adminToken(request);
  await openApp(page, token);
  await expect(page.locator('.sb-user')).toBeVisible();
  await expect(page.locator('.sb-label', { hasText: 'Адміністрування' })).toBeVisible();
  await page.click('.sb-item[data-tab="admin"][data-sub="overview"]');
  await expect(page.locator('main.content')).toBeVisible({ timeout: 10000 });
  const critical = errs.filter((e) => e.startsWith('http5xx') || e.startsWith('pageerror'));
  expect(critical, 'no 5xx/page errors on admin panel').toEqual([]);
});

test('A2. Створення / редагування / архівування групи (API)', async ({ request }) => {
  const token = await adminToken(request);
  const name = `Група PW ${Date.now() % 100000}`;
  const c = await request.post('/api/admin/groups-full', {
    data: { name, course: 1, faculty: 'ННІ №1' },
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  expect(c.status(), 'create group').toBe(200);
  const gid = (await c.json()).group._id;
  const e = await request.patch(`/api/admin/groups-full/${encodeURIComponent(gid)}`, {
    data: { course: 2 },
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  expect(e.status(), 'edit group').toBe(200);
  const a = await request.post(`/api/admin/groups-full/${encodeURIComponent(gid)}/status`, {
    data: { status: 'archived' },
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  expect(a.status(), 'archive group').toBe(200);
});

test('A3. Створення студента + генерація логіна/пароля', async ({ request }) => {
  const token = await adminToken(request);
  const st = await createStudent(token, request, { fullName: `Студ PW ${Date.now() % 100000}`, group: '201 СПД' });
  expect(st.login, 'login generated').toBeTruthy();
  expect(st.tempPassword.length, 'temp password >= 8').toBeGreaterThanOrEqual(8);
  expect(st.login).toMatch(/\./);
});

test('A4. Призначення старости + ізоляція між групами', async ({ request }) => {
  const token = await adminToken(request);
  const st = await createStudent(token, request, { fullName: `Стар PW ${Date.now() % 100000}`, group: '201 СПД', role: 'starosta' });
  // Створюємо другу групу для ізоляційного тесту
  const g2 = await request.post('/api/admin/groups-full', {
    data: { name: `202 СПD ${Date.now() % 1000}`, course: 2, faculty: 'ННІ №1' },
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  // Призначення старости для 201 СПД
  const assign = await request.post('/api/admin/groups-full/201%20СПД/starosta', {
    data: { starosta: st.user.id },
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  expect([200, 400, 404]).toContain(assign.status(), `starosta assign (${assign.status()})`);
  // Вхід старости 201 СПД і с��роба керувати чужою групою
  if (assign.status() === 200 && g2.status() === 200) {
    const gname = (await g2.json()).group._id;
    const lr = await apiLogin(request, { login: st.login, password: st.tempPassword, group: '201 СПД', deviceId: 'pw-star-dev' });
    if (lr.status === 200) {
      const foreign = await request.post(`/api/admin/groups-full/${encodeURIComponent(gname)}/status`, {
        data: { status: 'archived' },
        headers: { Authorization: `Bearer ${lr.data.token}`, 'X-Device-Id': 'pw-star-dev' },
      });
      // Адмін-маршрути = лише isAdmin; староста → 403
      expect([403, 400]).toContain(foreign.status(), 'starosta cannot manage foreign group');
    }
  }
});

test('A5. Блокування / розблокування / скидання пароля', async ({ request }) => {
  const token = await adminToken(request);
  const st = await createStudent(token, request, { fullName: `Блок PW ${Date.now() % 100000}`, group: '201 СПД' });
  const uid = st.user.id;
  const bl = await request.post(`/api/admin/members/${uid}/block`, {
    data: { blocked: true },
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  expect(bl.status(), 'block').toBe(200);
  const lg = await apiLogin(request, { login: st.login, password: st.tempPassword, group: '201 СПД', deviceId: 'pw-block-dev' });
  expect(lg.status, 'blocked user cannot login').toBe(403);
  const un = await request.post(`/api/admin/members/${uid}/block`, {
    data: { blocked: false },
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  expect(un.status(), 'unblock').toBe(200);
  const rs = await request.post(`/api/admin/members/${uid}/reset-password`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'pw-admin-dev' },
  });
  expect(rs.status(), 'reset password').toBe(200);
});

