# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: student.spec.js >> S4. Головна + профіль + оцінки + розклад
- Location: test/pw/student.spec.js:102:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.sidebar .sb-user')
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('.sidebar .sb-user') with timeout 15000ms
  - waiting for locator('.sidebar .sb-user')

```

```yaml
- link "Пропустити до контенту":
  - /url: "#app"
- img "Емблема НАВС"
- text: Національна академія внутрішніх справ Електронний щоденник Логін
- textbox "Логін":
  - /placeholder: ivanenko.ip
- text: Пароль
- textbox "Пароль":
  - /placeholder: ••••••••
- button "Показати або сховати пароль"
- text: Мінімум 8 символів, щонайменше одна літера і цифра Навчальна група
- combobox "Оберіть навчальну групу":
  - option "Оберіть свою групу" [selected]
  - option "101 СПД (курс 1)"
  - option "201 СПД (курс 1)"
- button "Увійти"
- button "Вхід за прізвищем"
- alert
```

# Test source

```ts
  8   | const ADMIN_NAME = process.env.PW_ADMIN_NAME || 'Адміністраторенко Адмін Адмінович';
  9   | const DEVICE = 'pw-student-dev-1';
  10  | 
  11  | async function adminToken(req) {
  12  |   const r = await apiLogin(req, { fullName: ADMIN_NAME, deviceId: 'pw-admin-dev' });
  13  |   if (r.status !== 200) throw new Error(`admin login failed: ${r.status} ${JSON.stringify(r.data)}`);
  14  |   return r.data.token;
  15  | }
  16  | 
  17  | /** Змінює тимчасовий пароль через API (щоб студент отримав повний доступ до застосунку). */
  18  | async function changeTempPassword(req, st, deviceId = DEVICE) {
  19  |   // Спочатку вхід тимчасовим паролем, щоб отримати токен.
  20  |   const lg = await apiLogin(req, { login: st.login, password: st.tempPassword, group: '201 СПД', deviceId });
  21  |   if (lg.status !== 200) throw new Error(`temp login failed: ${lg.status}`);
  22  |   const ch = await req.post('/api/auth/change-password', {
  23  |     data: { newPassword: 'ChPwd99xyz', confirmPassword: 'ChPwd99xyz' },
  24  |     headers: { Authorization: `Bearer ${lg.data.token}`, 'X-Device-Id': deviceId },
  25  |   });
  26  |   if (ch.status() !== 200) throw new Error(`change password failed: ${ch.status()}`);
  27  |   st.newPassword = 'ChPwd99xyz';
  28  |   return st;
  29  | }
  30  | async function ensureGroup(req, name, course = 1) {
  31  |   const tok = await adminToken(req);
  32  |   const res = await req.post('/api/admin/groups-full', {
  33  |     data: { name, course, faculty: 'ННІ №1' },
  34  |     headers: { Authorization: `Bearer ${tok}`, 'X-Device-Id': 'pw-admin-dev' },
  35  |   });
  36  |   if (![200, 409].includes(res.status())) {
  37  |     throw new Error(`ensure group ${name} failed: ${res.status()} ${await res.text().catch(() => '')}`);
  38  |   }
  39  | }
  40  | 
  41  | async function freshStudent(req, group = '201 СПД') {
  42  |   await ensureGroup(req, group);
  43  |   return createStudent(await adminToken(req), req, { fullName: `ПІБ Тест ${Date.now() % 100000}`, group, role: 'student' });
  44  | }
  45  | 
  46  | test('S1. Відкриття сторінки входу + емблема НАВС + список груп', async ({ page }) => {
  47  |   const errs = collectErrors(page);
  48  |   await page.goto(baseUrl());
  49  |   await expect(page.locator('img.navs-crest')).toBeVisible();
  50  |   const groupSel = page.locator('#loginGroup');
  51  |   await expect(groupSel).toBeVisible();
  52  |   const opts = await groupSel.locator('option').allTextContents();
  53  |   expect(opts.length, 'group options loaded').toBeGreaterThan(0);
  54  |   const critical = errs.filter((e) => e.startsWith('http5xx') || e.startsWith('pageerror'));
  55  |   expect(critical, 'no 5xx/page errors on login').toEqual([]);
  56  | });
  57  | 
  58  | /** Чекає, поки у випадаючому списку груп на сторінці входу з'явиться група `name`.
  59  |  * Опції <option> не мають стану "visible" у DOM (приховані, доки <select> не відкрито),
  60  |  * тому очікуємо на state 'attached'. */
  61  | async function waitGroupOption(page, name) {
  62  |   await page.waitForSelector('#loginGroup option', { state: 'attached', timeout: 15000 });
  63  |   const present = await page.locator(`#loginGroup option[value="${name}"]`).count();
  64  |   if (present > 0) return;
  65  |   // loadNavsGroups оновлює select асинхронно — чекаємо появи нужної опції.
  66  |   await page.waitForSelector(`#loginGroup option[value="${name}"]`, { state: 'attached', timeout: 15000 });
  67  | }
  68  | 
  69  | test('S2. Вхід з неправильним паролем відхиляється', async ({ page, request }) => {
  70  |   const st = await freshStudent(request);
  71  |   await page.goto(baseUrl());
  72  |   await waitGroupOption(page, '201 СПД');
  73  |   await page.fill('#loginUser', st.login);
  74  |   await page.fill('#loginPass', 'WrongPassword1');
  75  |   await page.selectOption('#loginGroup', '201 СПД');
  76  |   await page.click('#loginBtn');
  77  |   // Чекаємо, поки сервер відповість і повідомлення про помилку з'явиться.
  78  |   const errEl = page.locator('#loginErr');
  79  |   await expect(errEl).not.toHaveText('', { timeout: 10000 });
  80  |   const err = await errEl.textContent();
  81  |   expect(err, 'login error shown').toMatch(/невірний|пароль/i);
  82  |   const tok = await page.evaluate(() => localStorage.getItem('token'));
  83  |   expect(tok, 'no token on failed login').toBeFalsy();
  84  | });
  85  | 
  86  | test('S3. Правильний вхід + примусова зміна пароля', async ({ page, request }) => {
  87  |   const st = await freshStudent(request);
  88  |   await page.goto(baseUrl());
  89  |   await waitGroupOption(page, '201 СПД');
  90  |   await page.fill('#loginUser', st.login);
  91  |   await page.fill('#loginPass', st.tempPassword);
  92  |   await page.selectOption('#loginGroup', '201 СПД');
  93  |   await page.click('#loginBtn');
  94  |   await expect(page.locator('#changePassForm')).toBeVisible({ timeout: 10000 });
  95  |   await page.fill('#newPass', 'NewSecure123');
  96  |   await page.fill('#confirmPass', 'NewSecure123');
  97  |   await page.click('#changePassBtn');
  98  |   await expect(page.locator('#changePassForm')).toBeHidden({ timeout: 15000 });
  99  |   await expect(page.locator('.sb-user')).toBeVisible();
  100 | });
  101 | 
  102 | test('S4. Головна + профіль + оцінки + розклад', async ({ page, request }) => {
  103 |   const st = await freshStudent(request);
  104 |   await changeTempPassword(request, st);
  105 |   const r = await apiLogin(request, { login: st.login, password: st.newPassword, group: '201 СПД', deviceId: DEVICE });
  106 |   expect(r.status, 'student login with changed password').toBe(200);
  107 |   await openApp(page, r.data.token);
> 108 |   await expect(page.locator('.sidebar .sb-user')).toBeVisible({ timeout: 15000 });
      |                                                   ^ Error: expect(locator).toBeVisible() failed
  109 |   await page.click('.sb-item[data-tab="settings"][data-sub="profile"]');
  110 |   await expect(page.locator('main.content')).toBeVisible({ timeout: 10000 });
  111 |   await page.click('.sb-item[data-tab="progress"][data-sub="scores"]');
  112 |   await expect(page.locator('main.content')).toBeVisible({ timeout: 10000 });
  113 |   await page.click('.sb-item[data-tab="schedule"]');
  114 |   await expect(page.locator('main.content')).toBeVisible();
  115 | });
  116 | 
  117 | test('S5. Безпечний вихід + повторний вхід', async ({ page, request }) => {
  118 |   const st = await freshStudent(request);
  119 |   await changeTempPassword(request, st);
  120 |   const r = await apiLogin(request, { login: st.login, password: st.newPassword, group: '201 СПД', deviceId: DEVICE });
  121 |   await openApp(page, r.data.token);
  122 |   await expect(page.locator('.sb-user')).toBeVisible({ timeout: 15000 });
  123 |   const lo = await page.request.post('/api/auth/logout');
  124 |   expect(lo.status(), 'logout 200').toBe(200);
  125 |   const me = await page.request.get('/api/me/scores', { headers: { Authorization: `Bearer ${r.data.token}`, 'X-Device-Id': DEVICE } });
  126 |   expect([401, 403]).toContain(me.status(), `stale session rejected (${me.status()})`);
  127 | });
  128 | 
  129 | 
```