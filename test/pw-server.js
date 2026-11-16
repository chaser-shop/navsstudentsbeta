'use strict';
/*
 * Запускає ізольований test-сервер НАВС на in-memory MongoDB + локальний
 * Google-Sheets-фейк. Пише порт в test/pw-meta.json. Працює як webServer.command.
 * Не використовує production-базу.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');

const ROOT = path.join(__dirname, '..');
const META = path.join(__dirname, 'pw-meta.json');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'sheet.csv'), 'utf8');
const ADMIN = 'Адміністраторенко Адмін Адмінович';

(async () => {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));

  Object.assign(process.env, {
    MONGODB_URI: mongo.getUri('navs_pw'),
    DB_NAME: 'navs_pw',
    ADMIN_NAMES: ADMIN,
    GOOGLE_SHEET_CSV_URL: `http://127.0.0.1:${fixture.address().port}/sheet.csv`,
    GOOGLE_SHEET_GROUP: 'ТЕСТ-1',
    VAPID_SUBJECT: 'mailto:pw-test@diary.local',
    PORT: '0',
  });

  const app = require(path.join(ROOT, 'server.js'));
  const TEST_PORT = parseInt(process.env.PW_TEST_PORT || '4180', 10);
  const { port } = await app.start({ port: TEST_PORT, schedulers: false });
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(META, JSON.stringify({ baseUrl }, null, 2));
  console.log(`[pw-server] NAVS test app listening at ${baseUrl}`);

  const shutdown = async () => {
    console.log('[pw-server] shutting down');
    try { await app.stop(); } catch { /* ок */ }
    fixture.close();
    await mongo.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((e) => {
  console.error('[pw-server] failed to start:', e);
  process.exit(1);
});
