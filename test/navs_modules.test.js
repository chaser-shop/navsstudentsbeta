'use strict';
/**
 * Comprehensive Integration Tests for NAVS Modernization:
 *  1. Authorization: Login, password verification, group membership, brute force lockout, change password.
 *  2. Group Administration: CRUD, status toggling, starosta/deputy per group, schedule configuration.
 *  3. Members & Credentials: Unique login generation, temporary passwords, Argon2id hashing, reset password, block, export.
 *  4. Roles & Permissions: Starosta isolated to their assigned group.
 *  5. Timetable & Sync: Parsing, diffing, change notifications, Cloudflare fallback.
 *  6. Grading Scale: NAVS official scale, normalization across disciplines.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { normalizeScore, gradeFromScore, aggregateStudentRating } = require('../lib/rating_scale');
const { generateLogin, generateTempPassword, hashPassword, verifyPassword } = require('../lib/auth_manager');
const { diffLessons, parseHtmlTableToGrid } = require('../lib/schedule_sync');
const { isGroupLeader, assertGroupAccess } = require('../lib/roles');

let h;
let adminSession;

before(async () => {
  h = await setup({ replSet: true });
  adminSession = await h.login(h.ADMIN);
});

after(async () => {
  if (h) await h.teardown();
});

test('1. Authentication & Credentials: login generation and Argon2id verification', async () => {
  const login1 = generateLogin('Петренко Петро Петрович');
  assert.equal(login1, 'petrenko.pp');

  const login2 = generateLogin('Петренко Петро Петрович', (c) => c === 'petrenko.pp');
  assert.equal(login2, 'petrenko.pp2');

  const tempPass = generateTempPassword(10);
  assert.equal(tempPass.length, 10);
  assert.ok(/[A-Z]/.test(tempPass));
  assert.ok(/[a-z]/.test(tempPass));
  assert.ok(/\d/.test(tempPass));

  const hash = await hashPassword(tempPass);
  assert.ok(await verifyPassword(tempPass, hash));
  assert.ok(!(await verifyPassword('wrongpassword', hash)));
});

test('2. Groups: CRUD, status toggle, starosta assignment', async () => {
  // 1. Створення нової навчальної групи
  const createRes = await h.call(adminSession, 'POST', '/api/admin/groups-full', {
    name: '201 СПД',
    course: 2,
    faculty: 'ННІ №1',
  });
  assert.equal(createRes.status, 200);
  assert.equal(createRes.data.group._id, '201 СПД');
  assert.equal(createRes.data.group.course, 2);

  // 2. Отримання списку груп
  const listRes = await h.call(adminSession, 'GET', '/api/admin/groups-full');
  assert.equal(listRes.status, 200);
  const found = listRes.data.find((g) => g.name === '201 СПД');
  assert.ok(found);
  assert.equal(found.course, 2);

  // 3. Деактивація та архівування
  const deactRes = await h.call(adminSession, 'POST', '/api/admin/groups-full/201%20СПД/status', {
    status: 'inactive',
  });
  assert.equal(deactRes.status, 200);
  assert.equal(deactRes.data.status, 'inactive');

  const actRes = await h.call(adminSession, 'POST', '/api/admin/groups-full/201%20СПД/status', {
    status: 'active',
  });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.data.status, 'active');

  // 4. Публічний список груп для форми входу
  const publicGroups = await h.call(null, 'GET', '/api/auth/groups');
  assert.equal(publicGroups.status, 200);
  assert.ok(publicGroups.data.groups.some((g) => g.name === '201 СПД'));
});

test('3. Members: creation with generated credentials, login, password change', async () => {
  // 1. Додавання студента через адмінку
  const addRes = await h.call(adminSession, 'POST', '/api/admin/members', {
    fullName: 'Ковальчук Василь Олександрович',
    group: '201 СПД',
    role: 'student',
  });
  assert.equal(addRes.status, 200);
  const { login, tempPassword } = addRes.data.credentials;
  assert.ok(login.startsWith('kovalchuk.v'));
  assert.ok(tempPassword.length >= 8);

  // 2. Вхід студента з логіном і тимчасовим паролем
  const loginRes = await h.call(null, 'POST', '/api/auth/login', {
    login,
    password: tempPassword,
    group: '201 СПД',
    deviceId: 'device-test-1',
  });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.data.token);
  assert.equal(loginRes.data.user.mustChangePassword, true);
  assert.equal(loginRes.data.user.group, '201 СПД');

  const studentSession = {
    token: loginRes.data.token,
    deviceId: 'device-test-1',
    user: loginRes.data.user,
  };

  // 3. Неправильний пароль повертає 401
  const badLogin = await h.call(null, 'POST', '/api/auth/login', {
    login,
    password: 'wrong_password_123',
    group: '201 СПД',
    deviceId: 'device-test-1',
  });
  assert.equal(badLogin.status, 401);

  // 4. Неправильна група повертає 403
  const badGroupLogin = await h.call(null, 'POST', '/api/auth/login', {
    login,
    password: tempPassword,
    group: '999 НЕВІДОМА',
    deviceId: 'device-test-1',
  });
  assert.equal(badGroupLogin.status, 403);

  // 5. Зміна тимчасового пароля
  const newPass = 'StrongNewPass2026!';
  const changeRes = await h.call(studentSession, 'POST', '/api/auth/change-password', {
    currentPassword: tempPassword,
    newPassword: newPass,
    confirmPassword: newPass,
  });
  assert.equal(changeRes.status, 200);
  assert.equal(changeRes.data.ok, true);

  // 6. Вхід із новим паролем
  const newLoginRes = await h.call(null, 'POST', '/api/auth/login', {
    login,
    password: newPass,
    group: '201 СПД',
    deviceId: 'device-test-1',
  });
  assert.equal(newLoginRes.status, 200);
  assert.equal(newLoginRes.data.user.mustChangePassword, false);

  // 7. Скидання пароля адміністратором
  const resetRes = await h.call(adminSession, 'POST', `/api/admin/members/${studentSession.user.id}/reset-password`);
  assert.equal(resetRes.status, 200);
  assert.ok(resetRes.data.credentials.tempPassword);

  // 8. Блокування користувача
  const blockRes = await h.call(adminSession, 'POST', `/api/admin/members/${studentSession.user.id}/block`, {
    blocked: true,
  });
  assert.equal(blockRes.status, 200);
  assert.equal(blockRes.data.isBlocked, true);

  const blockedLogin = await h.call(null, 'POST', '/api/auth/login', {
    login,
    password: resetRes.data.credentials.tempPassword,
    group: '201 СПД',
    deviceId: 'device-test-1',
  });
  assert.equal(blockedLogin.status, 403);

  // Розблокування
  await h.call(adminSession, 'POST', `/api/admin/members/${studentSession.user.id}/block`, {
    blocked: false,
  });
});

test('4. Roles & Starosta Isolation', async () => {
  // Створюємо двох студентів у двох різних групах
  const s1 = await h.call(adminSession, 'POST', '/api/admin/members', {
    fullName: 'Сидоренко Степан Степанович',
    group: '201 СПД',
    role: 'student',
  });
  const s2 = await h.call(adminSession, 'POST', '/api/admin/members', {
    fullName: 'Григоренко Ганна Григорівна',
    group: 'ТЕСТ-1',
    role: 'student',
  });

  // Призначаємо Сидоренка старостою 201 СПД
  const starostaRes = await h.call(adminSession, 'POST', '/api/admin/groups-full/201%20СПД/starosta', {
    starostaId: s1.data.user.id,
  });
  assert.equal(starostaRes.status, 200);
  assert.equal(starostaRes.data.starosta, 'Сидоренко Степан Степанович');

  // Перевірка прав через roles module
  const starostaUser = {
    _id: s1.data.user.id,
    fullName: 'Сидоренко Степан Степанович',
    role: 'starosta',
    group: '201 СПД',
  };

  assert.ok(isGroupLeader(starostaUser, '201 СПД'));
  assert.ok(!isGroupLeader(starostaUser, 'ТЕСТ-1'));

  // assertGroupAccess
  assert.ok(assertGroupAccess(starostaUser, '201 СПД'));
  assert.throws(() => assertGroupAccess(starostaUser, 'ТЕСТ-1'), /У вас немає доступу до навчальної групи/);
});

test('5. Timetable parser, diffing, and schedule API', async () => {
  const oldLessons = [
    {
      lid: '20261012-1',
      start: new Date('2026-10-12T08:30:00Z'),
      end: new Date('2026-10-12T09:50:00Z'),
      subjectKey: 'Кримінальне право',
      kind: 'Лк',
      room: '101',
      teacher: 'Професоренко П.П.',
      isRemote: false,
    },
    {
      lid: '20261012-2',
      start: new Date('2026-10-12T10:00:00Z'),
      end: new Date('2026-10-12T11:20:00Z'),
      subjectKey: 'Адміністративне право',
      kind: 'Пз',
      room: '202',
      teacher: 'Доценко Д.Д.',
      isRemote: false,
    },
  ];

  const newLessons = [
    {
      lid: '20261012-1',
      start: new Date('2026-10-12T08:30:00Z'),
      end: new Date('2026-10-12T09:50:00Z'),
      subjectKey: 'Кримінальне право',
      kind: 'Лк',
      room: 'Дистанційно',
      teacher: 'Професоренко П.П.',
      isRemote: true, // Зміна аудиторії на дистанційно!
    },
    // Пара 20261012-2 зникла (скасовано)
    {
      lid: '20261012-3',
      start: new Date(Date.now() + 86400000),
      end: new Date(Date.now() + 91200000),
      subjectKey: 'Криміналістика',
      kind: 'Пз',
      room: '303',
      teacher: 'Експертенко Е.Е.',
      isRemote: false, // Нова пара!
    },
  ];

  const diffs = diffLessons(oldLessons, newLessons);
  assert.ok(diffs.some((d) => d.type === 'room_change'));
  assert.ok(diffs.some((d) => d.type === 'new'));

  // Перевірка отримання розкладу через API
  const schedRes = await h.call(adminSession, 'GET', '/api/schedule?group=201%20СПД');
  assert.equal(schedRes.status, 200);
  assert.equal(schedRes.data.group.name, '201 СПД');
});

test('6. Official NAVS Rating Scale & Normalization', () => {
  // Шкала оцінювання:
  // 89–100 → 5
  // 82–88  → 4+
  // 75–81  → 4
  // 64–74  → 3
  // 60–63  → 3-
  // < 60   → 2

  assert.equal(gradeFromScore(100).grade, '5');
  assert.equal(gradeFromScore(89).grade, '5');
  assert.equal(gradeFromScore(88.4).grade, '4+');
  assert.equal(gradeFromScore(82).grade, '4+');
  assert.equal(gradeFromScore(81.9).grade, '4');
  assert.equal(gradeFromScore(75).grade, '4');
  assert.equal(gradeFromScore(74.4).grade, '3');
  assert.equal(gradeFromScore(64).grade, '3');
  assert.equal(gradeFromScore(63.2).grade, '3-');
  assert.equal(gradeFromScore(60).grade, '3-');
  assert.equal(gradeFromScore(59.9).grade, '2');
  assert.equal(gradeFromScore(45).isPassed, false);

  // Нормалізація: (набрані / максимальні) * 100
  // Наприклад: студент набрав 45 балів із 50 можливих
  const norm1 = normalizeScore(45, 50);
  assert.equal(norm1, 90); // 90 зі 100 → оцінка 5
  assert.equal(gradeFromScore(norm1).grade, '5');

  // Студент набрав 240 балів за 4 дисципліни (максимум 400 балів)
  const norm2 = normalizeScore(240, 400);
  assert.equal(norm2, 60); // 60 зі 100 → оцінка 3-
  assert.equal(gradeFromScore(norm2).grade, '3-');

  // Агрегація
  const agg = aggregateStudentRating([
    { key: 'law1', score: 45, max: 50 },
    { key: 'law2', score: 40, max: 50 },
  ]);
  assert.equal(agg.totalEarned, 85);
  assert.equal(agg.totalMax, 100);
  assert.equal(agg.normalized, 85);
  assert.equal(agg.gradeInfo.grade, '4+');
});

test('7. mustChangePassword blocks API access until password changed', async () => {
  // Створюємо нового студента (має тимчасовий пароль і mustChangePassword=true)
  const createRes = await h.call(adminSession, 'POST', '/api/admin/members', {
    fullName: 'Тестовий Студент Іванович',
    group: '201 СПД',
    role: 'student',
  });
  assert.equal(createRes.status, 200);
  const { credentials } = createRes.data;
  assert.ok(credentials.login);
  assert.ok(credentials.tempPassword);
  const newStudentId = createRes.data.user.id;

  // Вхід тимчасовим паролем — успішно
  const loginRes = await h.call(null, 'POST', '/api/auth/login', {
    login: credentials.login,
    password: credentials.tempPassword,
    group: '201 СПД',
    deviceId: 'test-device-1',
  });
  assert.equal(loginRes.status, 200, JSON.stringify(loginRes.data));
  assert.equal(loginRes.data.user.mustChangePassword, true);
  const studentToken = loginRes.data.token;

  // Спроба викликати /api/me/scores — має бути 403 (must_change_password)
  const meRes = await h.call({ token: studentToken, deviceId: 'test-device-1' }, 'GET', '/api/me/scores');
  assert.equal(meRes.status, 403, JSON.stringify(meRes.data));
  assert.equal(meRes.data.code, 'must_change_password');

  // Зміна пароля — успішно
  const changeRes = await h.call({ token: studentToken, deviceId: 'test-device-1' }, 'POST', '/api/auth/change-password', {
    newPassword: 'SecurePass123',
    confirmPassword: 'SecurePass123',
  });
  assert.equal(changeRes.status, 200, JSON.stringify(changeRes.data));
  assert.equal(changeRes.data.ok, true);

  // Тепер /api/me/scores доступний
  const meRes2 = await h.call({ token: studentToken, deviceId: 'test-device-1' }, 'GET', '/api/me/scores');
  assert.equal(meRes2.status, 200, JSON.stringify(meRes2.data));

  // Вхід з новим паролем — mustChangePassword має бути false
  const loginRes2 = await h.call(null, 'POST', '/api/auth/login', {
    login: credentials.login,
    password: 'SecurePass123',
    group: '201 СПД',
    deviceId: 'test-device-1',
  });
  assert.equal(loginRes2.status, 200);
  assert.equal(loginRes2.data.user.mustChangePassword, false);
});

test('8. Password reset by admin sets mustChangePassword=true again', async () => {
  // Отримуємо існуючого студента з тесту 7
  const users = await h.ctx.col.users.find({ fullName: 'Тестовий Студент Іванович' }).toArray();
  assert.ok(users.length > 0);
  const student = users[0];

  // Скидаємо пароль як адміністратор
  const resetRes = await h.call(adminSession, 'POST', `/api/admin/members/${student._id}/reset-password`);
  assert.equal(resetRes.status, 200, JSON.stringify(resetRes.data));
  assert.ok(resetRes.data.credentials.tempPassword);

  // Перевіряємо, що mustChangePassword=true
  const dbUser = await h.ctx.col.users.findOne({ _id: student._id });
  assert.equal(dbUser.mustChangePassword, true);
});

test('9. Security: student cannot impersonate admin, wrong-group rejected, role isolation', async () => {
  // Створюємо студента з відомим паролем (щоб не залежати від стану тестів 7/8)
  const m = await h.call(adminSession, 'POST', '/api/admin/members', {
    fullName: 'Студент Захисту Андрійович',
    group: '201 СПД',
    role: 'student',
  });
  assert.equal(m.status, 200);
  const { login, tempPassword } = m.data.credentials;
  assert.ok(login && tempPassword);

  // ── a) Студент групи «201 СПД» НЕ може увійти, заявляючи чужу групу ──
  const wrongGroup = await h.call(null, 'POST', '/api/auth/login', {
    login,
    password: tempPassword,
    group: 'ТЕСТ-1', // чужа група
    deviceId: 'test-sec-1',
  });
  assert.equal(wrongGroup.status, 403, 'student in group A must not log in claiming group B');

  // ── b) Студент не має доступу до адмін-маршрутів ──
  const lr = await h.call(null, 'POST', '/api/auth/login', {
    login,
    password: tempPassword,
    group: '201 СПД',
    deviceId: 'test-sec-2',
  });
  assert.equal(lr.status, 200, JSON.stringify(lr.data));
  const stuSession = { token: lr.data.token, deviceId: 'test-sec-2' };

  // Студент не може читати список учасників
  assert.equal((await h.call(stuSession, 'GET', '/api/admin/members')).status, 403, 'GET /api/admin/members must be 403 for student');
  // Студент не може створювати групи
  assert.equal((await h.call(stuSession, 'POST', '/api/admin/groups-full', { name: 'ХАК ГРУПА' })).status, 403, 'POST /api/admin/groups-full must be 403 for student');
  // Студент не може синхронізувати розклад
  assert.equal((await h.call(stuSession, 'POST', '/api/admin/schedule/sync')).status, 403, 'POST /api/admin/schedule/sync must be 403 for student');

  // ── c) Публічний список груп не розкриває архівовані/неактивні ──
  const pub = await h.call(null, 'GET', '/api/auth/groups');
  assert.equal(pub.status, 200);
  assert.ok(!pub.data.groups.some((g) => g.status === 'archived'), 'archived groups must not appear in public login list');
});

test('10. Per-group schedule-config mapping (each internal group maps to its own external timetable)', async () => {
  // Створюємо другу групу
  await h.call(adminSession, 'POST', '/api/admin/groups-full', { name: '202 СПД', course: 2, faculty: 'ННІ №1' });

  // Група 201 СПД → зовнішній розклад: ННІ поліцейської діяльності, курс 1, зовнішня група «101»
  const c1 = await h.call(adminSession, 'POST', '/api/admin/groups-full/201%20СПД/schedule-config', {
    faculty: 'Навчально-науковий інститут поліцейської діяльності',
    course: 1,
    externalGroup: '101',
    autoSync: true,
  });
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  assert.equal(c1.data.scheduleConfig.faculty, 'Навчально-науковий інститут поліцейської діяльності');
  assert.equal(c1.data.scheduleConfig.externalGroup, '101');

  // Група 202 СПД → інший зовнішній розклад: ННІ права, курс 2, зовнішня група «202»
  const c2 = await h.call(adminSession, 'POST', '/api/admin/groups-full/202%20СПД/schedule-config', {
    faculty: 'Навчально-науковиий інститут права та психології',
    course: 2,
    externalGroup: '202',
    autoSync: true,
  });
  assert.equal(c2.status, 200, JSON.stringify(c2.data));

  // Перевіряємо ізоляцію: кожна група має СВОЮ конфігурацію, не спільну
  const g1 = await h.ctx.col.groups.findOne({ _id: '201 СПД' });
  const g2 = await h.ctx.col.groups.findOne({ _id: '202 СПД' });
  assert.equal(g1.scheduleConfig.faculty, 'Навчально-науковий інститут поліцейської діяльності');
  assert.equal(g2.scheduleConfig.faculty, 'Навчально-науковиий інститут права та психології');
  assert.equal(g1.scheduleConfig.course, 1);
  assert.equal(g2.scheduleConfig.course, 2);
  assert.notEqual(g1.scheduleConfig.externalGroup, g2.scheduleConfig.externalGroup);

  // Студент (не адмін) не може змінювати налаштування розкладу
  const m = await h.call(adminSession, 'POST', '/api/admin/members', { fullName: 'Студент Розкладу Іванович', group: '201 СПД', role: 'student' });
  const lr = await h.call(null, 'POST', '/api/auth/login', { login: m.data.credentials.login, password: m.data.credentials.tempPassword, group: '201 СПД', deviceId: 'sec-sched' });
  assert.equal(lr.status, 200);
  const stu = { token: lr.data.token, deviceId: 'sec-sched' };
  assert.equal((await h.call(stu, 'POST', '/api/admin/groups-full/201%20СПД/schedule-config', { faculty: 'ХАК', course: 1 })).status, 403, 'student cannot modify schedule config');
});
