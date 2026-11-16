'use strict';
// Одиноразові скриншоти для візуальної перевірки редизайну. Запуск: node test/_shots.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'pw-meta.json'), 'utf8')).baseUrl;
  const br = await chromium.launch();
  const page = await br.newPage();

  // Light desktop login
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(b + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('img.navs-crest', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/final-login.png' });

  // Dark desktop login
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('img.navs-crest', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/final-login-dark.png' });

  // Mobile login
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('img.navs-crest', { timeout: 20000 });
  await page.screenshot({ path: '/tmp/final-mobile.png' });

  console.log('screenshots done: /tmp/final-login.png /tmp/final-login-dark.png /tmp/final-mobile.png');
  await br.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
