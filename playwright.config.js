'use strict';
/*
 * Playwright конфігурація для НАВС Щоденника.
 * - webServer запускає ізольований test-сервер (node test/pw-server.js) на in-memory MongoDB.
 * - Desktop + mobile viewports.
 * - Скриншоти + traces + video при падінні, HTML-звіт.
 * - Не дивиться в production.
 */
const { defineConfig, devices } = require('playwright/test');
const fs = require('fs');
const path = require('path');

const DESKTOP = [
  { name: 'desktop-1920', viewport: { width: 1920, height: 1080 } },
  { name: 'desktop-1440', viewport: { width: 1440, height: 900 } },
  { name: 'desktop-1366', viewport: { width: 1366, height: 768 } },
  { name: 'desktop-1280', viewport: { width: 1280, height: 800 } },
];
const MOBILE = [
  { name: 'iphone-390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { name: 'iphone-375', viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1' },
  { name: 'android-412', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
];

// webServer запускає server, але порт динамічний (0). Тому після старту Playwright
// пише pw-meta.json; webServer.waitUntil перевіряє /healthz на базовому порті.
// Для простоти: фіксний порт 4180, щоб Playwright міг чекати.
const TEST_PORT = 4180;

module.exports = defineConfig({
  testDir: './test/pw',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test/reports/playwright', open: 'never' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${TEST_PORT}`,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    outputDir: 'test/reports/playwright/artifacts',
    actionTimeout: 15_000,
  },
  webServer: {
    command: 'node test/pw-server.js',
    url: `http://127.0.0.1:${TEST_PORT}/healthz`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { PW_TEST_PORT: String(TEST_PORT) },
  },
  projects: [
    ...DESKTOP.map((d) => ({
      name: `chromium:${d.name}`,
      use: { ...devices['Chromium'], ...d },
    })),
    ...MOBILE.map((m) => ({
      name: `chromium:${m.name}`,
      use: { ...devices['Chromium'], ...m },
    })),
  ],
});
