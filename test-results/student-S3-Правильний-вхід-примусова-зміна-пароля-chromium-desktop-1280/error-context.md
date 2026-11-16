# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: student.spec.js >> S3. Правильний вхід + примусова зміна пароля
- Location: test/pw/student.spec.js:47:1

# Error details

```
Error: create member

expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 401
```

# Test source

```ts
  1  | 'use strict';
  2  | /*
  3  |  * Спільний хелпер для Playwright-тестів НАВС.
  4  |  * - apiLogin (Request-фіктура, без браузера) для API-операцій.
  5  |  * - openApp (Page) для відображення інтерфейсу.
  6  |  * - collectErrors (Page) для збору console/JS/network помилок.
  7  |  */
  8  | 
  9  | const { test, expect, request } = require('@playwright/test');
  10 | const fs = require('fs');
  11 | const path = require('path');
  12 | 
  13 | function baseUrl() {
  14 |   const b = process.env.PW_BASE_URL;
  15 |   if (b) return b;
  16 |   // Fallback: мета-файл, записаний у globalSetup (надійніше за process.env між процесами).
  17 |   try {
  18 |     const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pw-meta.json'), 'utf8'));
  19 |     return meta.baseUrl;
  20 |   } catch {
  21 |     throw new Error('PW_BASE_URL not set and pw-meta.json missing — was globalSetup run?');
  22 |   }
  23 | }
  24 | 
  25 | /** Логін через API (Request, без браузера). */
  26 | async function apiLogin(req, body) {
  27 |   const res = await req.post('/api/auth/login', { data: body });
  28 |   const data = await res.json().catch(() => ({}));
  29 |   return { status: res.status(), data };
  30 | }
  31 | 
  32 | /** Створює студента через адмін-API. */
  33 | async function createStudent(adminTok, req, { fullName, group, role = 'student' }) {
  34 |   const res = await req.post('/api/admin/members', {
  35 |     data: { fullName, group, role },
  36 |     headers: { Authorization: `Bearer ${adminTok}`, 'X-Device-Id': 'pw-admin-dev-1' },
  37 |   });
> 38 |   expect(res.status(), 'create member').toBe(200);
     |                                         ^ Error: create member
  39 |   const data = await res.json();
  40 |   return {
  41 |     user: data.user,
  42 |     login: data.credentials.login,
  43 |     tempPassword: data.credentials.tempPassword,
  44 |   };
  45 | }
  46 | 
  47 | /** Переходить на сторінку з авторизованим токеном. */
  48 | async function openApp(page, token) {
  49 |   await page.goto('/');
  50 |   await page.evaluate((t) => localStorage.setItem('token', t), token);
  51 |   await page.reload();
  52 |   await page.waitForSelector('.sb-user, #loginForm, #changePassForm', { timeout: 20000 });
  53 | }
  54 | 
  55 | /** Збирає console errors, pageerror і failed-запити. */
  56 | function collectErrors(page) {
  57 |   const errors = [];
  58 |   page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  59 |   page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  60 |   page.on('requestfailed', (req) => {
  61 |     if (req.url().includes('/api/')) errors.push(`requestfailed: ${req.method()} ${req.url()}`);
  62 |   });
  63 |   page.on('response', (res) => {
  64 |     if (res.url().includes('/api/') && res.status() >= 500) errors.push(`http5xx: ${res.status()} ${res.url()}`);
  65 |   });
  66 |   return errors;
  67 | }
  68 | 
  69 | module.exports = { test, expect, request, baseUrl, apiLogin, createStudent, openApp, collectErrors };
  70 | 
  71 | 
```