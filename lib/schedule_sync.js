'use strict';
/**
 * NAVS Official Timetable Synchronization Service.
 * Official source: https://asu.navs.edu.ua/time-table/group
 * 
 * Features:
 *  - Per-group schedule mapping (Faculty, Course, External Group).
 *  - Automated periodic sync (default 60 min, configurable in dashboard).
 *  - Mutual exclusion (lock) to prevent duplicate concurrent runs.
 *  - Robust Cloudflare detection & fallback to last successful DB schedule.
 *  - Comprehensive diffing engine (new, cancelled, rescheduled, room, teacher, subject).
 *  - Automated student notifications on schedule changes.
 *  - Full sync run log and change history in MongoDB.
 */

const ctx = require('./context');
const notify = require('./notify');
const { str, toDate, clampInt, uuid } = require('./util');
const ScheduleParser = require('../public/schedule.js');

let syncTimer = null;
let isSyncing = false;
let syncIntervalMs = 60 * 60 * 1000; // 60 хв за замовчуванням

/**
 * Отримує налаштування синхронізації з БД.
 */
async function getScheduleConfig() {
  const doc = await ctx.col.config.findOne({ _id: 'scheduleSyncConfig' });
  return doc ? doc.value : {
    intervalMinutes: 60,
    autoSync: true,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
}

/**
 * Зберігає налаштування синхронізації в БД.
 */
async function saveScheduleConfig(cfg) {
  await ctx.col.config.updateOne(
    { _id: 'scheduleSyncConfig' },
    { $set: { value: cfg } },
    { upsert: true }
  );
  if (cfg.intervalMinutes) {
    syncIntervalMs = Math.max(5, clampInt(cfg.intervalMinutes, 5, 1440, 60)) * 60 * 1000;
  }
}

/**
 * Парсер HTML таблиці розкладу ASU NAVS у матрицю клітинок [row][col].
 */
function parseHtmlTableToGrid(html) {
  const grid = [];
  if (!html) return grid;

  // Виділяємо рядки таблиці
  const rowMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!rowMatches) return grid;

  for (const tr of rowMatches) {
    const row = [];
    const cellMatches = tr.match(/<(td|th)[^>]*>([\s\S]*?)<\/(td|th)>/gi);
    if (!cellMatches) continue;

    for (const cell of cellMatches) {
      // Очищення HTML тегів та форматування
      let text = cell
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
      row.push(text);
    }
    if (row.length) grid.push(row);
  }
  return grid;
}

/**
 * Виконує HTTP-запит до сайту розкладу НАВС з виявленням Cloudflare Turnstile.
 */
async function fetchScheduleFromNavs(url = 'https://asu.navs.edu.ua/time-table/group', postData = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
    };

    let response;
    if (postData) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: new URLSearchParams(postData).toString(),
        signal: controller.signal,
      });
    } else {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    }

    const html = await response.text();
    clearTimeout(timeoutId);

    // Перевірка на захист Cloudflare Turnstile
    if (
      html.includes('challenges.cloudflare.com') ||
      html.includes('_cf_chl_opt') ||
      html.includes('Just a moment...') ||
      response.status === 403
    ) {
      return {
        ok: false,
        status: 'cloudflare_challenge',
        error: 'Сайт asu.navs.edu.ua захищено Cloudflare Turnstile (Managed Challenge). Потрібен прямий HTML або кліренс-сесія.',
        html,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: 'http_error',
        error: `Помилка сервера НАВС (HTTP ${response.status})`,
        html,
      };
    }

    return { ok: true, status: 'ok', html };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      status: 'network_error',
      error: `Мережева помилка зв'язку з НАВС: ${err.message}`,
    };
  }
}

/**
 * Порівнює старий і новий розклад групи та генерує список змін.
 */
function diffLessons(oldLessons = [], newLessons = []) {
  const oldMap = new Map();
  for (const l of oldLessons) {
    const key = l.lid || l._id;
    if (key) oldMap.set(key, l);
  }

  const newMap = new Map();
  for (const l of newLessons) {
    const key = l.lid || l._id;
    if (key) newMap.set(key, l);
  }

  const changes = [];

  // Перевірка змінених або нових пар
  for (const [key, n] of newMap.entries()) {
    const o = oldMap.get(key);
    if (!o) {
      changes.push({
        type: 'new',
        title: 'Нова пара',
        lessonId: key,
        oldLesson: null,
        newLesson: n,
        description: `Додано нову пару: ${n.subjectKey} (${n.kind || 'Пара'}) о ${new Date(n.start).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}`,
      });
    } else {
      // Порівнюємо параметри пари
      const startChanged = new Date(o.start).getTime() !== new Date(n.start).getTime();
      const endChanged = new Date(o.end).getTime() !== new Date(n.end).getTime();
      const roomChanged = (o.room || '') !== (n.room || '') || !!o.isRemote !== !!n.isRemote;
      const teacherChanged = (o.teacher || '') !== (n.teacher || '');
      const subjectChanged = (o.subjectKey || '') !== (n.subjectKey || '');
      const kindChanged = (o.kind || '') !== (n.kind || '');

      if (startChanged || endChanged) {
        changes.push({
          type: 'rescheduled',
          title: 'Перенесення пари',
          lessonId: key,
          oldLesson: o,
          newLesson: n,
          description: `Змінено час пари «${n.subjectKey}»: новий початок о ${new Date(n.start).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}`,
        });
      } else if (roomChanged) {
        const placeStr = n.isRemote ? 'Дистанційно' : (n.room ? `ауд. ${n.room}` : 'без аудиторії');
        changes.push({
          type: 'room_change',
          title: 'Зміна аудиторії',
          lessonId: key,
          oldLesson: o,
          newLesson: n,
          description: `Пара «${n.subjectKey}»: нове місце — ${placeStr}`,
        });
      } else if (teacherChanged) {
        changes.push({
          type: 'teacher_change',
          title: 'Зміна викладача',
          lessonId: key,
          oldLesson: o,
          newLesson: n,
          description: `Пара «${n.subjectKey}»: викладач — ${n.teacher || 'не вказано'}`,
        });
      } else if (subjectChanged || kindChanged) {
        changes.push({
          type: 'subject_change',
          title: 'Зміна предмету/типу',
          lessonId: key,
          oldLesson: o,
          newLesson: n,
          description: `Пара змінена на: ${n.subjectKey} (${n.kind || 'Пара'})`,
        });
      }
    }
  }

  // Перевірка скасованих пар
  for (const [key, o] of oldMap.entries()) {
    if (!newMap.has(key)) {
      // Якщо пара була в майбутньому і зникла — скасовано
      if (new Date(o.start).getTime() > Date.now()) {
        changes.push({
          type: 'cancelled',
          title: 'Скасування пари',
          lessonId: key,
          oldLesson: o,
          newLesson: null,
          description: `Скасовано пару «${o.subjectKey}» за ${new Date(o.start).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', timeZone: 'Europe/Kyiv' })}`,
        });
      }
    }
  }

  return changes;
}

/**
 * Сповіщає студентів групи про виявлені зміни розкладу.
 */
async function notifyGroupScheduleChanges(groupName, changes = []) {
  if (!changes.length || !ctx.db) return 0;

  // Знаходимо всіх студентів цієї групи
  const groupUsers = await ctx.db.collection('users').find({
    group: groupName,
    isBlocked: { $ne: true },
  }).toArray();

  if (!groupUsers.length) return 0;
  const userIds = groupUsers.map((u) => u._id);

  let notifiedCount = 0;
  for (const ch of changes) {
    const notifDoc = {
      _id: uuid(),
      group: groupName,
      type: 'schedule_change',
      changeType: ch.type,
      title: ch.title,
      body: ch.description,
      lessonId: ch.lessonId,
      createdAt: new Date(),
    };

    // Запис у колекцію сповіщень для кожного студента групи
    await Promise.allSettled(
      userIds.map((uid) =>
        ctx.col.notifications.insertOne({
          _id: uuid(),
          userId: uid,
          title: ch.title,
          body: ch.description,
          tag: `sched-${ch.lessonId}-${Date.now()}`,
          data: { url: '/?tab=schedule', group: groupName },
          createdAt: new Date(),
          read: false,
        })
      )
    );

    // Надсилання Web Push
    const subs = await ctx.db.collection('pushSubs').find({
      userId: { $in: userIds },
      'settings.notificationsEnabled': true,
    }).toArray();

    if (subs.length && typeof ctx.sendPush === 'function') {
      const payload = {
        title: `${groupName}: ${ch.title}`,
        body: ch.description,
        tag: `sched-${ch.lessonId}`,
        data: { url: '/?tab=schedule' },
        ttl: 86400,
      };
      const res = await Promise.allSettled(subs.map((s) => ctx.sendPush(s, payload)));
      notifiedCount += res.filter((r) => r.status === 'fulfilled' && r.value && r.value.ok).length;
    }
  }

  return notifiedCount;
}

/**
 * Синхронізує розклад для однієї або всіх груп.
 * @param {string|null} targetGroupName - назва групи або null для всіх
 * @param {object} options - { force: boolean, htmlContent: string|null, actor: string }
 */
async function syncSchedule(targetGroupName = null, options = {}) {
  if (isSyncing) {
    return { ok: false, error: 'Синхронізація розкладу вже виконується.' };
  }
  isSyncing = true;
  const startTime = Date.now();
  const runId = uuid();

  try {
    const groupsFilter = targetGroupName ? { _id: targetGroupName } : {};
    const groups = await ctx.col.groups.find(groupsFilter).toArray();

    if (!groups.length) {
      return { ok: false, error: targetGroupName ? `Групу «${targetGroupName}» не знайдено.` : 'Немає налаштованих груп.' };
    }

    const results = [];
    const scheduleCol = ctx.db.collection('navs_schedule');
    const changesCol = ctx.db.collection('schedule_changes');
    const runsCol = ctx.db.collection('schedule_sync_runs');

    for (const group of groups) {
      const gName = group._id;
      const schedCfg = group.scheduleConfig || {};

      let parsedResult = null;
      let syncStatus = 'success';
      let errorMsg = null;

      if (options.htmlContent) {
        // Ручний імпорт / переданий HTML
        try {
          const grid = parseHtmlTableToGrid(options.htmlContent);
          parsedResult = ScheduleParser.parse(grid);
        } catch (e) {
          syncStatus = 'failed';
          errorMsg = `Помилка розбору наданого HTML: ${e.message}`;
        }
      } else {
        // Отримання з офіційного сайту НАВС
        const fetchRes = await fetchScheduleFromNavs('https://asu.navs.edu.ua/time-table/group', {
          faculty: schedCfg.faculty || '',
          course: schedCfg.course || '',
          group: schedCfg.externalGroup || gName,
        });

        if (!fetchRes.ok) {
          syncStatus = fetchRes.status === 'cloudflare_challenge' ? 'blocked_cloudflare' : 'failed';
          errorMsg = fetchRes.error;
        } else {
          try {
            const grid = parseHtmlTableToGrid(fetchRes.html);
            parsedResult = ScheduleParser.parse(grid);
          } catch (e) {
            syncStatus = 'failed';
            errorMsg = `Не вдалося розібрати таблицю розкладу: ${e.message}`;
          }
        }
      }

      // Якщо розклад успішно розібрано
      if (parsedResult && Array.isArray(parsedResult.lessons)) {
        // Читаємо попередній розклад для цієї групи
        const oldLessons = await scheduleCol.find({ group: gName }).toArray();
        const diffs = diffLessons(oldLessons, parsedResult.lessons);

        // Зберігаємо зміни у БД
        if (diffs.length) {
          const changeDocs = diffs.map((d) => ({
            _id: uuid(),
            group: gName,
            runId,
            changeType: d.type,
            title: d.title,
            description: d.description,
            lessonId: d.lessonId,
            oldLesson: d.oldLesson,
            newLesson: d.newLesson,
            detectedAt: new Date(),
          }));
          await changesCol.insertMany(changeDocs);
          await notifyGroupScheduleChanges(gName, diffs);
        }

        // Оновлюємо пари в колекції розкладу
        await scheduleCol.deleteMany({ group: gName });
        if (parsedResult.lessons.length) {
          const toInsert = parsedResult.lessons.map((l) => ({
            _id: `${gName}|${l.id}`,
            group: gName,
            lid: l.id,
            pair: l.pair,
            start: toDate(l.start),
            end: toDate(l.end),
            subjectKey: l.subjectKey,
            kind: l.kind || '',
            topic: l.topic || '',
            room: l.room || '',
            teacher: l.teacher || '',
            isRemote: !!l.isRemote,
            updatedAt: new Date(),
          }));
          await scheduleCol.insertMany(toInsert);
        }

        // Оновлюємо статус групи
        await ctx.col.groups.updateOne(
          { _id: gName },
          {
            $set: {
              'scheduleConfig.lastSyncAt': new Date(),
              'scheduleConfig.lastStatus': 'success',
              'scheduleConfig.lastError': null,
              'scheduleConfig.lessonsCount': parsedResult.lessons.length,
            },
          }
        );

        results.push({
          group: gName,
          status: 'success',
          lessonsCount: parsedResult.lessons.length,
          changesCount: diffs.length,
          changes: diffs,
        });
      } else {
        // Помилка або блокування: зберігаємо статус, але НЕ видаляємо старий розклад!
        await ctx.col.groups.updateOne(
          { _id: gName },
          {
            $set: {
              'scheduleConfig.lastSyncAttempt': new Date(),
              'scheduleConfig.lastStatus': syncStatus,
              'scheduleConfig.lastError': errorMsg,
            },
          }
        );

        results.push({
          group: gName,
          status: syncStatus,
          error: errorMsg,
          preservedOldSchedule: true,
        });
      }
    }

    const durationMs = Date.now() - startTime;
    const overallStatus = results.every((r) => r.status === 'success')
      ? 'success'
      : results.some((r) => r.status === 'success')
      ? 'partial'
      : (results[0] && results[0].status) || 'failed';

    const runRecord = {
      _id: runId,
      startedAt: new Date(startTime),
      finishedAt: new Date(),
      durationMs,
      actor: options.actor || 'system',
      targetGroup: targetGroupName,
      status: overallStatus,
      results,
    };
    await runsCol.insertOne(runRecord);

    await saveScheduleConfig({
      ...(await getScheduleConfig()),
      lastRunAt: new Date(),
      lastSuccessAt: overallStatus === 'success' ? new Date() : (await getScheduleConfig()).lastSuccessAt,
      lastError: overallStatus === 'success' ? null : (results[0] && results[0].error),
    });

    return {
      ok: true,
      runId,
      status: overallStatus,
      durationMs,
      results,
    };
  } catch (err) {
    return { ok: false, error: `Системна помилка синхронізації розкладу: ${err.message}` };
  } finally {
    isSyncing = false;
  }
}

/**
 * Запуск фонового таймера синхронізації.
 */
function startScheduleScheduler() {
  if (syncTimer) clearInterval(syncTimer);
  getScheduleConfig().then((cfg) => {
    if (cfg && cfg.intervalMinutes) {
      syncIntervalMs = Math.max(5, clampInt(cfg.intervalMinutes, 5, 1440, 60)) * 60 * 1000;
    }
    syncTimer = setInterval(() => {
      syncSchedule(null, { actor: 'scheduler' }).catch((e) =>
        console.error('Schedule scheduler error:', e)
      );
    }, syncIntervalMs);
  });
}

function stopScheduleScheduler() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

module.exports = {
  getScheduleConfig,
  saveScheduleConfig,
  parseHtmlTableToGrid,
  fetchScheduleFromNavs,
  diffLessons,
  syncSchedule,
  startScheduleScheduler,
  stopScheduleScheduler,
};
