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

/** Створює студента через адмін-API. */
async function createStudent(adminTok, req, { fullName, group, role = 'student' }) {
  const res = await req.post('/api/admin/members', {
    data: { fullName, group, role },
    headers: { Authorization: `Bearer ${adminTok}`, 'X-Device-Id': 'pw-admin-dev-1' },
  });
  expect(res.status(), 'create member').toBe(200);
  const data = await res.json();
  return {
    user: data.user,
    login: data.credentials.login,
    tempPassword: data.credentials.tempPassword,
  };
}

/** Переходить на сторінку з авторизованим токеном. */
async function openApp(page, token) {
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('token', t), token);
  await page.reload();
  await page.waitForSelector('.sb-user, #loginForm, #changePassForm', { timeout: 20000 });
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

module.exports = { test, expect, request, baseUrl, apiLogin, createStudent, openApp, collectErrors };

