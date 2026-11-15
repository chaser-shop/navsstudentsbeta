'use strict';
/**
 * Routes for NAVS Timetable and Automatic Synchronization.
 * 
 * Endpoints:
 *  - GET  /api/schedule                Get schedule for user's group (or admin filtered group)
 *  - GET  /api/admin/schedule/settings Get sync settings & status
 *  - PUT  /api/admin/schedule/settings Update sync settings
 *  - POST /api/admin/schedule/sync     Trigger manual sync now
 *  - POST /api/admin/schedule/import   Manual upload/paste of HTML/CSV schedule
 *  - GET  /api/admin/schedule/changes  Get history of schedule changes
 *  - GET  /api/admin/schedule/runs     Get sync execution history log
 */

const ctx = require('../context');
const { audit } = require('../audit');
const { HttpError, str, clampInt, toDate } = require('../util');
const { getScheduleConfig, saveScheduleConfig, syncSchedule } = require('../schedule_sync');
const { canModerateResource } = require('../roles');

function register(route) {
  // Перегляд розкладу для студентів та адміністраторів
  route('GET', '/api/schedule', async ({ user, query }) => {
    let group = query.get('group');
    if (!group) {
      group = (user && user.group) || '101 СПД';
    }

    // Якщо це звичайний студент і запитує іншу групу — дозволяємо лише перегляд, але пріоритет своїй
    const scheduleCol = ctx.db.collection('navs_schedule');
    const changesCol = ctx.db.collection('schedule_changes');

    const [lessons, groupDoc, changes] = await Promise.all([
      scheduleCol.find({ group }).sort({ start: 1 }).toArray(),
      ctx.col.groups.findOne({ _id: group }),
      changesCol.find({ group }).sort({ detectedAt: -1 }).limit(10).toArray(),
    ]);

    return {
      group: {
        id: group,
        name: group,
        course: (groupDoc && groupDoc.course) || 1,
        faculty: (groupDoc && groupDoc.faculty) || 'ННІ №1',
        lastSyncAt: groupDoc && groupDoc.scheduleConfig && groupDoc.scheduleConfig.lastSyncAt,
        lastStatus: groupDoc && groupDoc.scheduleConfig && groupDoc.scheduleConfig.lastStatus,
      },
      lessons: lessons.map((l) => ({
        id: l.lid || l._id,
        pair: l.pair,
        start: l.start,
        end: l.end,
        subjectKey: l.subjectKey,
        kind: l.kind || '',
        topic: l.topic || '',
        room: l.room || '',
        teacher: l.teacher || '',
        isRemote: !!l.isRemote,
      })),
      changes: changes.map((c) => ({
        id: c._id,
        type: c.changeType,
        title: c.title,
        description: c.description,
        detectedAt: c.detectedAt,
      })),
    };
  });

  // Отримання налаштувань синхронізації (адмін)
  route('GET', '/api/admin/schedule/settings', async () => {
    const [cfg, groups] = await Promise.all([
      getScheduleConfig(),
      ctx.col.groups.find({}).sort({ _id: 1 }).toArray(),
    ]);

    return {
      config: cfg,
      groups: groups.map((g) => ({
        id: g._id,
        name: g._id,
        scheduleConfig: g.scheduleConfig || {},
      })),
    };
  }, { admin: true });

  // Оновлення налаштувань синхронізації (адмін)
  route('PUT', '/api/admin/schedule/settings', async ({ body, user, ip }) => {
    const intervalMinutes = clampInt(body.intervalMinutes, 5, 1440, 60);
    const autoSync = body.autoSync !== false;

    const current = await getScheduleConfig();
    const updated = {
      ...current,
      intervalMinutes,
      autoSync,
    };

    await saveScheduleConfig(updated);
    await audit(user, 'schedule.settings_update', {}, updated, ip);
    return { ok: true, config: updated };
  }, { admin: true });

  // Ручний запуск синхронізації розкладу
  route('POST', '/api/admin/schedule/sync', async ({ body, user, ip }) => {
    const groupName = body.group ? str(body.group, 60).trim() : null;
    const res = await syncSchedule(groupName, {
      force: true,
      actor: user.fullName || 'admin',
    });

    await audit(user, 'schedule.sync_trigger', { group: groupName }, { status: res.status }, ip);
    return res;
  }, { admin: true });

  // Ручний імпорт розкладу через HTML/CSV
  route('POST', '/api/admin/schedule/import', async ({ body, user, ip }) => {
    const groupName = str(body.group, 60).trim();
    if (!groupName) throw new HttpError(400, 'Вкажіть навчальну групу.');

    const htmlContent = body.html ? String(body.html) : null;
    if (!htmlContent) throw new HttpError(400, 'Передайте вміст таблиці розкладу (HTML або текст).');

    const res = await syncSchedule(groupName, {
      htmlContent,
      force: true,
      actor: user.fullName || 'admin',
    });

    await audit(user, 'schedule.manual_import', { group: groupName }, { status: res.status }, ip);
    return res;
  }, { admin: true });

  // Журнал змін розкладу
  route('GET', '/api/admin/schedule/changes', async ({ query }) => {
    const group = query.get('group');
    const filter = {};
    if (group && group !== 'all') filter.group = group;

    const changes = await ctx.db.collection('schedule_changes')
      .find(filter)
      .sort({ detectedAt: -1 })
      .limit(50)
      .toArray();

    return changes.map((c) => ({
      id: c._id,
      group: c.group,
      type: c.changeType,
      title: c.title,
      description: c.description,
      lessonId: c.lessonId,
      oldLesson: c.oldLesson,
      newLesson: c.newLesson,
      detectedAt: c.detectedAt,
    }));
  }, { admin: true });

  // Журнал синхронізацій
  route('GET', '/api/admin/schedule/runs', async () => {
    const runs = await ctx.db.collection('schedule_sync_runs')
      .find({})
      .sort({ startedAt: -1 })
      .limit(30)
      .toArray();

    return runs.map((r) => ({
      id: r._id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      actor: r.actor,
      status: r.status,
      results: r.results || [],
    }));
  }, { admin: true });
}

module.exports = { register };
