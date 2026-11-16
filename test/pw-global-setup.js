'use strict';
/*
 * Playwright globalSetup: НЕ запуск сервера (для webServer-блоку config окремо).
 * Тут лише фіксуємо, що середовище готове. Сам сервер запускає webServer через
 * `webServer.command` (node test/pw-server.js), а Playwright чекає /healthz.
 */
const fs = require('fs');
const path = require('path');

async function setup() {
  // Очищуємо застарілий meta (якщо залишився).
  try { fs.unlinkSync(path.join(__dirname, 'pw-meta.json')); } catch { /* ок */ }
  return {};
}

module.exports = setup;

