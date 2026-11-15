'use strict';
/**
 * Routes for Group Administration and Member Credential Management.
 * 
 * Group Endpoints:
 *  - GET    /api/admin/groups-full         List all groups with course, faculty, starosta, deputy, student count, status
 *  - POST   /api/admin/groups-full         Create new group (name, course, faculty)
 *  - PATCH  /api/admin/groups-full/:id     Edit group (name, course, faculty, status)
 *  - POST   /api/admin/groups-full/:id/status Deactivate / Activate / Archive group
 *  - GET    /api/admin/groups-full/:id     Group details with student roster, stats, starosta, schedule config
 *  - POST   /api/admin/groups-full/:id/starosta Assign starosta and deputy specifically for this group
 *  - POST   /api/admin/groups-full/:id/schedule-config Save external timetable mapping (faculty, course, external group)
 *  - POST   /api/admin/groups-full/transfer Transfer students between groups
 * 
 * Member / Credential Endpoints:
 *  - GET    /api/admin/members             List members with filters (group, status, role, search)
 *  - POST   /api/admin/members             Create member (generates login + temporary password, hashes with Argon2id)
 *  - POST   /api/admin/members/:id/reset-password Reissue temporary password for a student
 *  - PATCH  /api/admin/members/:id         Edit member (fullName, group, role)
 *  - POST   /api/admin/members/:id/block   Toggle block status
 *  - POST   /api/admin/members/:id/archive Archive member account
 *  - GET    /api/admin/members/export      Export credentials to CSV format
 */

const ctx = require('../context');
const { audit } = require('../audit');
const { HttpError, str, normName, normKey, clampInt, uuid } = require('../util');
const { generateLogin, generateTempPassword, hashPassword, validatePasswordStrength } = require('../auth_manager');
const { ROLE_TITLES } = require('../roles');

function register(route) {
  // ───────────────────────── Навчальні групи ─────────────────────────

  route('GET', '/api/admin/groups-full', async () => {
    const [groupsList, usersList, ratingsList] = await Promise.all([
      ctx.col.groups.find({}).sort({ _id: 1 }).toArray(),
      ctx.col.users.find({ isBlocked: { $ne: true } }).toArray(),
      ctx.col.ratings.find({ active: { $ne: false } }).toArray(),
    ]);

    // Підрахунок кількості студентів та пошук старост
    const usersByGroup = new Map();
    for (const u of usersList) {
      const g = u.group || '';
      if (!usersByGroup.has(g)) usersByGroup.set(g, []);
      usersByGroup.get(g).push(u);
    }

    const ratingsByGroup = new Map();
    for (const r of ratingsList) {
      const g = r.group || '';
      if (!ratingsByGroup.has(g)) ratingsByGroup.set(g, []);
      ratingsByGroup.get(g).push(r);
    }

    return groupsList.map((g) => {
      const gUsers = usersByGroup.get(g._id) || [];
      const gRatings = ratingsByGroup.get(g._id) || [];
      const starosta = gUsers.find((u) => u.role === 'starosta') || (g.starostaName ? { fullName: g.starostaName, _id: g.starostaId } : null);
      const deputy = gUsers.find((u) => u.role === 'deputy') || (g.deputyName ? { fullName: g.deputyName, _id: g.deputyId } : null);

      return {
        id: g._id,
        name: g._id,
        course: g.course || 1,
        faculty: g.faculty || 'ННІ №1',
        status: g.status || (g.active === false ? 'inactive' : 'active'),
        active: g.active !== false && g.status !== 'inactive' && g.status !== 'archived',
        studentCount: Math.max(gUsers.length, gRatings.length),
        starosta: starosta ? { id: starosta._id, name: starosta.fullName } : null,
        deputy: deputy ? { id: deputy._id, name: deputy.fullName } : null,
        scheduleConfig: g.scheduleConfig || null,
        createdAt: g.createdAt || null,
      };
    });
  }, { admin: true });

  route('POST', '/api/admin/groups-full', async ({ body, user, ip }) => {
    const name = str(body.name, 60).trim();
    if (!name) throw new HttpError(400, 'Вкажіть назву групи (наприклад, 101 СПД).');
    const course = clampInt(body.course, 1, 6, 1);
    const faculty = str(body.faculty, 100).trim() || 'ННІ №1';

    const existing = await ctx.col.groups.findOne({ _id: name });
    if (existing) throw new HttpError(409, `Група «${name}» вже існує.`);

    const doc = {
      _id: name,
      course,
      faculty,
      status: 'active',
      active: true,
      starostaId: null,
      starostaName: '',
      deputyId: null,
      deputyName: '',
      scheduleConfig: {
        faculty: faculty,
        course: course,
        externalGroup: name,
        autoSync: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await ctx.col.groups.insertOne(doc);
    await audit(user, 'group.create', { id: name }, { name, course, faculty }, ip);
    return { ok: true, group: doc };
  }, { admin: true });

  route('PATCH', '/api/admin/groups-full/:id', async ({ params, body, user, ip }) => {
    const id = decodeURIComponent(params.id);
    const group = await ctx.col.groups.findOne({ _id: id });
    if (!group) throw new HttpError(404, 'Групу не знайдено.');

    const newName = body.name ? str(body.name, 60).trim() : null;
    const course = body.course !== undefined ? clampInt(body.course, 1, 6, group.course || 1) : group.course;
    const faculty = body.faculty !== undefined ? str(body.faculty, 100).trim() : group.faculty;
    const status = body.status ? str(body.status, 20) : group.status || 'active';

    const set = {
      course,
      faculty,
      status,
      active: status === 'active',
      updatedAt: new Date(),
    };

    if (newName && newName !== id) {
      const collision = await ctx.col.groups.findOne({ _id: newName });
      if (collision) throw new HttpError(409, `Група з назвою «${newName}» вже існує.`);
      
      // Перейменування групи у всіх зв'язаних колекціях
      await ctx.col.groups.deleteOne({ _id: id });
      await ctx.col.groups.insertOne({ ...group, _id: newName, ...set });
      await ctx.col.users.updateMany({ group: id }, { $set: { group: newName } });
      await ctx.col.ratings.updateMany({ group: id }, { $set: { group: newName } });
      await ctx.col.history.updateMany({ group: id }, { $set: { group: newName } });
      await ctx.db.collection('navs_schedule').updateMany({ group: id }, { $set: { group: newName } });
      
      await audit(user, 'group.rename', { id: newName, oldId: id }, { newName, course, faculty }, ip);
      return { ok: true, id: newName };
    }

    await ctx.col.groups.updateOne({ _id: id }, { $set: set });
    await audit(user, 'group.update', { id }, set, ip);
    return { ok: true, id };
  }, { admin: true });

  route('POST', '/api/admin/groups-full/:id/status', async ({ params, body, user, ip }) => {
    const id = decodeURIComponent(params.id);
    const status = str(body.status, 20); // 'active', 'inactive', 'archived'
    if (!['active', 'inactive', 'archived'].includes(status)) {
      throw new HttpError(400, 'Некоректний статус. Дозволені: active, inactive, archived.');
    }

    const active = status === 'active';
    await ctx.col.groups.updateOne(
      { _id: id },
      { $set: { status, active, updatedAt: new Date() } }
    );
    await audit(user, 'group.status', { id }, { status, active }, ip);
    return { ok: true, status };
  }, { admin: true });

  route('GET', '/api/admin/groups-full/:id', async ({ params }) => {
    const id = decodeURIComponent(params.id);
    const group = await ctx.col.groups.findOne({ _id: id });
    if (!group) throw new HttpError(404, 'Групу не знайдено.');

    const [members, ratingStudents, scheduleLessons, recentChanges] = await Promise.all([
      ctx.col.users.find({ group: id }).sort({ fullName: 1 }).toArray(),
      ctx.col.ratings.find({ group: id, active: { $ne: false } }).sort({ fullName: 1 }).toArray(),
      ctx.db.collection('navs_schedule').find({ group: id }).sort({ start: 1 }).toArray(),
      ctx.db.collection('schedule_changes').find({ group: id }).sort({ detectedAt: -1 }).limit(10).toArray(),
    ]);

    return {
      group: {
        id: group._id,
        name: group._id,
        course: group.course || 1,
        faculty: group.faculty || 'ННІ №1',
        status: group.status || (group.active === false ? 'inactive' : 'active'),
        starosta: group.starostaName ? { id: group.starostaId, name: group.starostaName } : null,
        deputy: group.deputyName ? { id: group.deputyId, name: group.deputyName } : null,
        scheduleConfig: group.scheduleConfig || {},
      },
      members: members.map((m) => ({
        id: m._id,
        fullName: m.fullName,
        login: m.login || '',
        role: m.role || 'student',
        roleTitle: ROLE_TITLES[m.role] || 'Студент',
        mustChangePassword: !!m.mustChangePassword,
        isBlocked: !!m.isBlocked,
        lastSeenAt: m.lastSeenAt || null,
        createdAt: m.createdAt || null,
      })),
      ratingCount: ratingStudents.length,
      lessonsCount: scheduleLessons.length,
      recentChanges: recentChanges.map((c) => ({
        id: c._id,
        type: c.changeType,
        title: c.title,
        description: c.description,
        detectedAt: c.detectedAt,
      })),
    };
  }, { admin: true });

  // Призначення старости та заступника конкретно для цієї групи
  route('POST', '/api/admin/groups-full/:id/starosta', async ({ params, body, user, ip }) => {
    const id = decodeURIComponent(params.id);
    const starostaId = body.starostaId ? str(body.starostaId, 64) : null;
    const deputyId = body.deputyId ? str(body.deputyId, 64) : null;

    let starostaName = '';
    let deputyName = '';

    // Скидаємо ролі попередніх старост цієї групи
    await ctx.col.users.updateMany(
      { group: id, role: { $in: ['starosta', 'deputy'] } },
      { $set: { role: 'student' } }
    );

    if (starostaId) {
      const stUser = await ctx.col.users.findOne({ _id: starostaId, group: id });
      if (!stUser) throw new HttpError(404, 'Студента на посаду старости не знайдено в цій групі.');
      starostaName = stUser.fullName;
      await ctx.col.users.updateOne({ _id: starostaId }, { $set: { role: 'starosta' } });
    }

    if (deputyId) {
      if (deputyId === starostaId) throw new HttpError(400, 'Одна людина не може бути одночасно старостою та заступником.');
      const depUser = await ctx.col.users.findOne({ _id: deputyId, group: id });
      if (!depUser) throw new HttpError(404, 'Студента на посаду заступника не знайдено в цій групі.');
      deputyName = depUser.fullName;
      await ctx.col.users.updateOne({ _id: deputyId }, { $set: { role: 'deputy' } });
    }

    await ctx.col.groups.updateOne(
      { _id: id },
      { $set: { starostaId, starostaName, deputyId, deputyName, updatedAt: new Date() } }
    );

    await audit(user, 'group.starosta_assign', { id }, { starostaId, starostaName, deputyId, deputyName }, ip);
    return { ok: true, starosta: starostaName, deputy: deputyName };
  }, { admin: true });

  // Збереження налаштувань розкладу для групи
  route('POST', '/api/admin/groups-full/:id/schedule-config', async ({ params, body, user, ip }) => {
    const id = decodeURIComponent(params.id);
    const faculty = str(body.faculty, 100).trim();
    const course = clampInt(body.course, 1, 6, 1);
    const externalGroup = str(body.externalGroup, 60).trim() || id;
    const autoSync = body.autoSync !== false;

    const schedCfg = {
      faculty,
      course,
      externalGroup,
      autoSync,
      updatedAt: new Date(),
    };

    await ctx.col.groups.updateOne(
      { _id: id },
      { $set: { scheduleConfig: schedCfg } }
    );

    await audit(user, 'group.schedule_config', { id }, schedCfg, ip);
    return { ok: true, scheduleConfig: schedCfg };
  }, { admin: true });

  // Перенесення студентів між групами
  route('POST', '/api/admin/groups-full/transfer', async ({ body, user, ip }) => {
    const userIds = Array.isArray(body.userIds) ? body.userIds.map((x) => str(x, 64)) : [];
    const targetGroup = str(body.targetGroup, 60).trim();

    if (!userIds.length) throw new HttpError(400, 'Оберіть принаймні одного студента для перенесення.');
    if (!targetGroup) throw new HttpError(400, 'Оберіть цільову групу.');

    const group = await ctx.col.groups.findOne({ _id: targetGroup });
    if (!group) throw new HttpError(404, `Цільову групу «${targetGroup}» не знайдено.`);

    await ctx.col.users.updateMany(
      { _id: { $in: userIds } },
      { $set: { group: targetGroup, role: 'student' } }
    );

    // Також оновлюємо групу в рейтингу для зв'язаних записів
    const users = await ctx.col.users.find({ _id: { $in: userIds } }).toArray();
    for (const u of users) {
      if (u.studentId) {
        await ctx.col.ratings.updateOne({ _id: u.studentId }, { $set: { group: targetGroup } });
      }
    }

    await audit(user, 'members.transfer', { targetGroup }, { count: userIds.length, userIds }, ip);
    return { ok: true, transferredCount: userIds.length };
  }, { admin: true });

  // ───────────────────────── Учасники та генерація облікових записів ─────────────────────────

  route('GET', '/api/admin/members', async ({ query }) => {
    const group = query.get('group') ? str(query.get('group'), 60).trim() : null;
    const search = query.get('search') ? str(query.get('search'), 100).trim().toLowerCase() : null;
    const role = query.get('role') ? str(query.get('role'), 20) : null;

    const filter = {};
    if (group && group !== 'all') filter.group = group;
    if (role && role !== 'all') filter.role = role;
    if (search) {
      filter.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { login: { $regex: search, $options: 'i' } },
      ];
    }

    const members = await ctx.col.users.find(filter).sort({ group: 1, fullName: 1 }).toArray();
    return members.map((m) => ({
      id: m._id,
      fullName: m.fullName,
      login: m.login || '',
      group: m.group || '—',
      role: m.role || 'student',
      roleTitle: ROLE_TITLES[m.role] || 'Студент',
      isAdmin: !!m.isAdmin,
      mustChangePassword: !!m.mustChangePassword,
      isBlocked: !!m.isBlocked,
      isArchived: !!m.isArchived,
      devicesCount: Array.isArray(m.deviceIds) ? m.deviceIds.length : 0,
      lastSeenAt: m.lastSeenAt || null,
      createdAt: m.createdAt || null,
    }));
  }, { admin: true });

  // Додавання нового учасника з автоматичною генерацією логіна та пароля
  route('POST', '/api/admin/members', async ({ body, user, ip }) => {
    const fullName = normName(body.fullName);
    if (!fullName || fullName.split(' ').length < 2) {
      throw new HttpError(400, 'Введіть коректне ПІБ (прізвище та ім’я обов’язкові).');
    }
    const groupName = str(body.group, 60).trim();
    if (!groupName) throw new HttpError(400, 'Оберіть навчальну групу.');

    const group = await ctx.col.groups.findOne({ _id: groupName });
    if (!group) throw new HttpError(404, `Групу «${groupName}» не знайдено.`);

    const role = str(body.role, 20) || 'student';
    const nameKey = normKey(fullName);

    // Перевірка чи вже існує такий ПІБ
    const existing = await ctx.col.users.findOne({ nameKey });
    if (existing) {
      throw new HttpError(409, `Користувач із ПІБ «${fullName}» вже існує в системі.`);
    }

    // Генерація унікального логіна
    const existingLogins = new Set(
      (await ctx.col.users.find({}, { projection: { login: 1 } }).toArray())
        .map((u) => u.login)
        .filter(Boolean)
    );
    const login = generateLogin(fullName, (cand) => existingLogins.has(cand));

    // Генерація тимчасового пароля
    const tempPassword = generateTempPassword(10);
    const passwordHash = await hashPassword(tempPassword);

    const userId = uuid();
    const newUser = {
      _id: userId,
      fullName,
      nameKey,
      login,
      passwordHash,
      mustChangePassword: true,
      group: groupName,
      role: ['starosta', 'deputy'].includes(role) ? role : 'student',
      isAdmin: false,
      isBlocked: false,
      isArchived: false,
      failedAttempts: 0,
      lockedUntil: null,
      deviceIds: [],
      deviceMeta: {},
      pendingDevices: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await ctx.col.users.insertOne(newUser);

    // Створюємо або лінкуємо запис у рейтингу
    let ratingDoc = await ctx.col.ratings.findOne({ group: groupName, nameKey });
    if (!ratingDoc) {
      ratingDoc = {
        _id: uuid(),
        fullName,
        nameKey,
        group: groupName,
        active: true,
        points: 0,
        scores: {},
        scoreMeta: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await ctx.col.ratings.insertOne(ratingDoc);
    }
    await ctx.col.users.updateOne({ _id: userId }, { $set: { studentId: ratingDoc._id, studentName: fullName } });

    await audit(user, 'member.create', { id: userId, login }, { fullName, group: groupName, role }, ip);

    return {
      ok: true,
      user: {
        id: userId,
        fullName,
        login,
        group: groupName,
        role: newUser.role,
      },
      credentials: {
        login,
        tempPassword,
      },
    };
  }, { admin: true });

  // Скидання пароля та видача нового тимчасового пароля
  route('POST', '/api/admin/members/:id/reset-password', async ({ params, user, ip }) => {
    const targetUser = await ctx.col.users.findOne({ _id: params.id });
    if (!targetUser) throw new HttpError(404, 'Користувача не знайдено.');

    // Якщо у користувача не було логіна, генеруємо
    let login = targetUser.login;
    if (!login) {
      const existingLogins = new Set(
        (await ctx.col.users.find({}, { projection: { login: 1 } }).toArray())
          .map((u) => u.login)
          .filter(Boolean)
      );
      login = generateLogin(targetUser.fullName, (cand) => existingLogins.has(cand));
    }

    const tempPassword = generateTempPassword(10);
    const passwordHash = await hashPassword(tempPassword);

    await ctx.col.users.updateOne(
      { _id: targetUser._id },
      {
        $set: {
          login,
          passwordHash,
          mustChangePassword: true,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        },
      }
    );

    await audit(user, 'member.reset_password', { id: targetUser._id, login }, {}, ip);

    return {
      ok: true,
      credentials: {
        login,
        tempPassword,
      },
    };
  }, { admin: true });

  // Редагування учасника (ПІБ, група, роль)
  route('PATCH', '/api/admin/members/:id', async ({ params, body, user, ip }) => {
    const targetUser = await ctx.col.users.findOne({ _id: params.id });
    if (!targetUser) throw new HttpError(404, 'Користувача не знайдено.');

    const set = { updatedAt: new Date() };
    if (body.fullName) {
      const fullName = normName(body.fullName);
      if (fullName.split(' ').length >= 2) {
        set.fullName = fullName;
        set.nameKey = normKey(fullName);
      }
    }
    if (body.group) {
      set.group = str(body.group, 60).trim();
    }
    if (body.role) {
      const r = str(body.role, 20);
      if (['student', 'starosta', 'deputy', 'admin'].includes(r)) {
        set.role = r;
      }
    }

    await ctx.col.users.updateOne({ _id: targetUser._id }, { $set: set });
    await audit(user, 'member.update', { id: targetUser._id }, set, ip);
    return { ok: true };
  }, { admin: true });

  // Блокування / розблокування учасника
  route('POST', '/api/admin/members/:id/block', async ({ params, body, user, ip }) => {
    const targetUser = await ctx.col.users.findOne({ _id: params.id });
    if (!targetUser) throw new HttpError(404, 'Користувача не знайдено.');
    if (targetUser.isAdmin) throw new HttpError(403, 'Неможливо заблокувати головного адміністратора.');

    const isBlocked = body.blocked !== false;
    await ctx.col.users.updateOne(
      { _id: targetUser._id },
      { $set: { isBlocked, updatedAt: new Date() } }
    );

    await audit(user, isBlocked ? 'member.block' : 'member.unblock', { id: targetUser._id }, { isBlocked }, ip);
    return { ok: true, isBlocked };
  }, { admin: true });

  // Архівування облікового запису
  route('POST', '/api/admin/members/:id/archive', async ({ params, body, user, ip }) => {
    const targetUser = await ctx.col.users.findOne({ _id: params.id });
    if (!targetUser) throw new HttpError(404, 'Користувача не знайдено.');
    if (targetUser.isAdmin) throw new HttpError(403, 'Неможливо архівувати головного адміністратора.');

    const isArchived = body.archived !== false;
    await ctx.col.users.updateOne(
      { _id: targetUser._id },
      { $set: { isArchived, isBlocked: isArchived, updatedAt: new Date() } }
    );

    await audit(user, isArchived ? 'member.archive' : 'member.unarchive', { id: targetUser._id }, { isArchived }, ip);
    return { ok: true, isArchived };
  }, { admin: true });

  // Експорт облікових записів у CSV
  route('GET', '/api/admin/members/export', async ({ query }) => {
    const group = query.get('group');
    const filter = { isArchived: { $ne: true } };
    if (group && group !== 'all') filter.group = group;

    const members = await ctx.col.users.find(filter).sort({ group: 1, fullName: 1 }).toArray();

    // Формуємо CSV
    const lines = ['"ПІБ","Група","Логін","Роль","Статус"'];
    for (const m of members) {
      const status = m.isBlocked ? 'Заблокований' : (m.mustChangePassword ? 'Тимчасовий пароль' : 'Активний');
      const role = ROLE_TITLES[m.role] || 'Студент';
      lines.push(`"${m.fullName}","${m.group || ''}","${m.login || ''}","${role}","${status}"`);
    }

    return {
      csv: '\uFEFF' + lines.join('\r\n'),
      filename: `navs-members-${group || 'all'}-${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }, { admin: true });
}

module.exports = { register };
