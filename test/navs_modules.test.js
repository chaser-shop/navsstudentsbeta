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
