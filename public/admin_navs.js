/*
 * NAVS Extended Administration Dashboard:
 *  - Full Groups Management (Table, Course, Faculty, Status, Detail Drawer, Schedule Config, Starostas)
 *  - Members & Credential Generation (Unique Logins, Temp Passwords, Copy Button, CSV Export, Block)
 *  - Timetable & ASU NAVS Automatic Synchronization (Interval, Sync Now, HTML Import, Diff History)
 *  - Per-Group Starostas & Deputies
 */
(() => {
  'use strict';
  const D = window.Diary;
  if (!D) return;
  const { S, api, esc, ic, ui, fmt, toast, badge } = D;
  const $ = (s, r = document) => r.querySelector(s);
  const render = () => D.render();

  const RENDERERS = { groups: viewNavsGroups, members: viewNavsMembers, schedule: viewNavsScheduleAdmin };

  const M = {
    groupsFull: null,
    members: null,
    membersQ: '',
    membersGroup: 'all',
    membersRole: 'all',
    schedSettings: null,
    schedChanges: null,
    schedRuns: null,
    selectedGroup: '101 СПД',
  };

  // ───────────────────────── Завантаження даних ─────────────────────────

  async function loadGroupsFull() {
    try {
      M.groupsFull = await api('GET', '/api/admin/groups-full');
      if (M.groupsFull && M.groupsFull.length && !M.selectedGroup) {
        M.selectedGroup = M.groupsFull[0].name;
      }
    } catch (e) {
      toast('Помилка завантаження груп: ' + e.message);
    }
    render();
  }

  async function loadMembers() {
    try {
      const qs = [];
      if (M.membersGroup && M.membersGroup !== 'all') qs.push('group=' + encodeURIComponent(M.membersGroup));
      if (M.membersRole && M.membersRole !== 'all') qs.push('role=' + encodeURIComponent(M.membersRole));
      if (M.membersQ) qs.push('search=' + encodeURIComponent(M.membersQ));
      M.members = await api('GET', '/api/admin/members' + (qs.length ? '?' + qs.join('&') : ''));
    } catch (e) {
      toast('Помилка завантаження учасників: ' + e.message);
    }
    render();
  }

  async function loadScheduleAdmin() {
    try {
      const [settings, changes, runs] = await Promise.all([
        api('GET', '/api/admin/schedule/settings'),
        api('GET', '/api/admin/schedule/changes' + (M.selectedGroup ? '?group=' + encodeURIComponent(M.selectedGroup) : '')),
        api('GET', '/api/admin/schedule/runs'),
      ]);
      M.schedSettings = settings;
      M.schedChanges = changes;
      M.schedRuns = runs;
    } catch (e) {
      toast('Помилка налаштувань розкладу: ' + e.message);
    }
    render();
  }

  // ───────────────────────── Навчальні групи ─────────────────────────

  function viewNavsGroups() {
    if (!M.groupsFull) return ui.skeleton(3, 96);

    let h = `
      <div class="card" style="margin-bottom:16px;">
        <div class="spread wrap" style="gap:12px;">
          <div>
            <div class="card-title" style="font-size:18px;">Навчальні групи НАВС</div>
            <div class="card-sub">Керування курсами, факультетами, розкладом та старостами груп</div>
          </div>
          <div class="btn-row">
            <button class="btn auto" data-act="navsGroupCreate">${ic('plus', 16)} Створити групу</button>
            <button class="btn ghost auto" data-act="navsTransferOpen">${ic('users', 16)} Перенести студентів</button>
          </div>
        </div>
      </div>

      <div class="card tbl-wrap" style="padding:0;overflow:hidden;">
        <table class="tbl" style="width:100%;margin:0;">
          <thead>
            <tr>
              <th>Назва групи</th>
              <th>Курс</th>
              <th>Факультет</th>
              <th>Студенти</th>
              <th>Староста</th>
              <th>Статус</th>
              <th style="text-align:right;">Дії</th>
            </tr>
          </thead>
          <tbody>
            ${M.groupsFull.map((g) => {
              const statusBadge = g.status === 'active'
                ? badge('Активна', 'green')
                : g.status === 'inactive'
                ? badge('Неактивна', 'warn')
                : badge('Архів', 'gray');

              return `
                <tr>
                  <td><b><button class="link" data-act="navsGroupDetail" data-id="${esc(g.id)}">${esc(g.name)}</button></b></td>
                  <td>${esc(g.course)} курс</td>
                  <td>${esc(g.faculty)}</td>
                  <td>${esc(g.studentCount)}</td>
                  <td>${esc((g.starosta && g.starosta.name) || '—')}</td>
                  <td>${statusBadge}</td>
                  <td style="text-align:right;">
                    <div class="btn-row" style="justify-content:flex-end;">
                      <button class="btn small soft" data-act="navsGroupDetail" data-id="${esc(g.id)}">Деталі</button>
                      <button class="btn small ghost" data-act="navsGroupSched" data-id="${esc(g.id)}">Розклад</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    return h;
  }

  function openCreateGroupModal() {
    D.openSheet({
      title: 'Створення нової групи',
      render: () => `
        <div class="card" style="max-width:440px;margin:0 auto;text-align:left;">
          <form id="createGroupForm" style="display:flex;flex-direction:column;gap:12px;">
            <label>
              <span class="label">Назва групи (наприклад: 101 СПД)</span>
              <input class="field" name="groupName" id="cgName" required placeholder="101 СПД" maxlength="40">
            </label>
            <label>
              <span class="label">Курс</span>
              <select class="field" name="groupCourse" id="cgCourse">
                <option value="1">1 курс</option>
                <option value="2">2 курс</option>
                <option value="3">3 курс</option>
                <option value="4">4 курс</option>
                <option value="5">5 курс (Магістратура)</option>
              </select>
            </label>
            <label>
              <span class="label">Факультет / Інститут</span>
              <select class="field" name="groupFaculty" id="cgFaculty">
                <option value="ННІ №1">ННІ №1 (Слідство та дізнання)</option>
                <option value="ННІ №2">ННІ №2 (Кримінальна поліція)</option>
                <option value="ННІ №3">ННІ №3 (Превентивна діяльність)</option>
                <option value="ННІ №4">ННІ №4 (Право та правоохоронна діяльність)</option>
              </select>
            </label>
            <div id="createGroupErr" class="err" style="min-height:16px;"></div>
            <button class="btn big" type="submit" id="submitCreateGroupBtn" style="width:100%;">Створити групу</button>
          </form>
        </div>
      `,
    });
  }

  async function openGroupDetailModal(groupId) {
    let details = null;
    try {
      details = await api('GET', `/api/admin/groups-full/${encodeURIComponent(groupId)}`);
    } catch (e) {
      toast('Не вдалося відкрити групу: ' + e.message);
      return;
    }

    const g = details.group;
    D.openSheet({
      wide: true,
      title: `Група «${g.name}»`,
      render: () => `
        <div style="display:flex;flex-direction:column;gap:16px;">
          <!-- Картка інформації -->
          <div class="card">
            <div class="spread wrap">
              <div>
                <div class="card-title">${esc(g.name)} · ${esc(g.course)} курс</div>
                <div class="card-sub">${esc(g.faculty)} · Статус: <b>${esc(g.status)}</b></div>
              </div>
              <div class="btn-row">
                <button class="btn small soft" data-act="navsStarostaAssign" data-id="${esc(g.id)}">Призначити старосту</button>
                <button class="btn small ghost" data-act="navsGroupSched" data-id="${esc(g.id)}">Налаштувати розклад</button>
                <button class="btn small deep" data-act="navsToggleGroupStatus" data-id="${esc(g.id)}" data-status="${g.status === 'active' ? 'inactive' : 'active'}">
                  ${g.status === 'active' ? 'Деактивувати' : 'Активувати'}
                </button>
              </div>
            </div>
            <div class="grid c3" style="margin-top:14px;">
              <div class="card deep tight">
                <span class="label">Староста</span>
                <b>${esc((g.starosta && g.starosta.name) || 'Не призначено')}</b>
              </div>
              <div class="card deep tight">
                <span class="label">Заступник старости</span>
                <b>${esc((g.deputy && g.deputy.name) || 'Не призначено')}</b>
              </div>
              <div class="card deep tight">
                <span class="label">Пар у розкладі</span>
                <b>${esc(details.lessonsCount)}</b>
              </div>
            </div>
          </div>

          <!-- Список учасників групи -->
          <div class="card tbl-wrap" style="padding:0;">
            <div style="padding:12px 16px;border-bottom:1px solid var(--line);font-weight:700;">
              Склад групи (${details.members.length} учасників)
            </div>
            <table class="tbl" style="width:100%;margin:0;">
              <thead>
                <tr>
                  <th>ПІБ</th>
                  <th>Логін</th>
                  <th>Роль</th>
                  <th>Останній вхід</th>
                  <th style="text-align:right;">Дії</th>
                </tr>
              </thead>
              <tbody>
                ${details.members.map((m) => `
                  <tr>
                    <td><b>${esc(m.fullName)}</b></td>
                    <td><code>${esc(m.login || '—')}</code></td>
                    <td>${badge(m.roleTitle, m.role === 'starosta' ? 'accent' : m.role === 'deputy' ? 'sky' : 'gray')}</td>
                    <td>${m.lastSeenAt ? esc(fmt.rel(m.lastSeenAt)) : 'ще не заходив'}</td>
                    <td style="text-align:right;">
                      <button class="btn small ghost" data-act="navsResetPass" data-id="${esc(m.id)}" data-name="${esc(m.fullName)}">Скинути пароль</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `,
    });
  }

  function openStarostaAssignModal(groupId) {
    const g = (M.groupsFull || []).find((x) => x.id === groupId);
    D.openSheet({
      title: `Призначення старости групи «${groupId}»`,
      render: () => `
        <div class="card" style="max-width:440px;margin:0 auto;text-align:left;">
          <form id="assignStarostaForm" data-gid="${esc(groupId)}" style="display:flex;flex-direction:column;gap:12px;">
            <div class="notice info small">
              Староста та заступник отримують права модерації завдань та розкладу <b>виключно для групи «${esc(groupId)}»</b>.
            </div>
            <label>
              <span class="label">Оберіть старосту</span>
              <select class="field" id="asStarostaId">
                <option value="">Не призначено (зняти)</option>
                ${((M.members || []).filter((m) => m.group === groupId)).map((m) => `
                  <option value="${esc(m.id)}" ${g && g.starosta && g.starosta.id === m.id ? 'selected' : ''}>${esc(m.fullName)}</option>
                `).join('')}
              </select>
            </label>
            <label>
              <span class="label">Оберіть заступника старости</span>
              <select class="field" id="asDeputyId">
                <option value="">Не призначено (зняти)</option>
                ${((M.members || []).filter((m) => m.group === groupId)).map((m) => `
                  <option value="${esc(m.id)}" ${g && g.deputy && g.deputy.id === m.id ? 'selected' : ''}>${esc(m.fullName)}</option>
                `).join('')}
              </select>
            </label>
            <div id="starostaErr" class="err" style="min-height:16px;"></div>
            <button class="btn big" type="submit" id="saveStarostaBtn" style="width:100%;">Зберегти призначення</button>
          </form>
        </div>
      `,
    });
  }

  function openGroupSchedConfigModal(groupId) {
    const g = (M.groupsFull || []).find((x) => x.id === groupId);
    const cfg = (g && g.scheduleConfig) || {};

    D.openSheet({
      title: `Розклад групи «${groupId}»`,
      render: () => `
        <div class="card" style="max-width:460px;margin:0 auto;text-align:left;">
          <form id="schedConfigForm" data-gid="${esc(groupId)}" style="display:flex;flex-direction:column;gap:12px;">
            <div class="notice info small">
              Вкажіть параметри відповідності на офіційному порталі НАВС (asu.navs.edu.ua) для цієї групи.
            </div>
            <label>
              <span class="label">Факультет</span>
              <select class="field" id="scFaculty">
                <option value="ННІ №1" ${cfg.faculty === 'ННІ №1' ? 'selected' : ''}>ННІ №1 (Слідство та дізнання)</option>
                <option value="ННІ №2" ${cfg.faculty === 'ННІ №2' ? 'selected' : ''}>ННІ №2 (Кримінальна поліція)</option>
                <option value="ННІ №3" ${cfg.faculty === 'ННІ №3' ? 'selected' : ''}>ННІ №3 (Превентивна діяльність)</option>
                <option value="ННІ №4" ${cfg.faculty === 'ННІ №4' ? 'selected' : ''}>ННІ №4 (Право та правоохоронна діяльність)</option>
              </select>
            </label>
            <label>
              <span class="label">Курс</span>
              <select class="field" id="scCourse">
                <option value="1" ${cfg.course == 1 ? 'selected' : ''}>1 курс</option>
                <option value="2" ${cfg.course == 2 ? 'selected' : ''}>2 курс</option>
                <option value="3" ${cfg.course == 3 ? 'selected' : ''}>3 курс</option>
                <option value="4" ${cfg.course == 4 ? 'selected' : ''}>4 курс</option>
                <option value="5" ${cfg.course == 5 ? 'selected' : ''}>5 курс</option>
              </select>
            </label>
            <label>
              <span class="label">Назва групи на сайті НАВС</span>
              <input class="field" id="scExternal" value="${esc(cfg.externalGroup || groupId)}" placeholder="Наприклад: 101 СПД">
            </label>
            <label class="check-row" style="margin-top:6px;">
              <input type="checkbox" id="scAuto" ${cfg.autoSync !== false ? 'checked' : ''}>
              <span>Автоматично оновлювати за розкладом сервісу</span>
            </label>
            <div id="schedConfigErr" class="err" style="min-height:16px;"></div>
            <button class="btn big" type="submit" id="saveSchedConfigBtn" style="width:100%;">Зберегти налаштування</button>
          </form>
        </div>
      `,
    });
  }

  // ───────────────────────── Учасники та генерація облікових записів ─────────────────────────

  function viewNavsMembers() {
    if (!M.members) return ui.skeleton(3, 96);

    let h = `
      <div class="card" style="margin-bottom:16px;">
        <div class="spread wrap" style="gap:12px;">
          <div>
            <div class="card-title" style="font-size:18px;">Учасники та облікові записи</div>
            <div class="card-sub">Генерація унікальних логінів, видача тимчасових паролів та безпечний експорт</div>
          </div>
          <div class="btn-row">
            <button class="btn auto" data-act="navsMemberAdd">${ic('plus', 16)} Додати учасника</button>
            <button class="btn ghost auto" data-act="navsExportMembers">${ic('file', 16)} Експорт CSV</button>
          </div>
        </div>
        <div class="grid c3" style="margin-top:14px;gap:10px;">
          <input class="field" type="search" id="membersSearchInp" placeholder="Пошук за ПІБ або логіном" value="${esc(M.membersQ)}" data-inp="membersSearch">
          <select class="field" data-chg="membersGroupFilter">
            <option value="all">Усі навчальні групи</option>
            ${(M.groupsFull || []).map((g) => `<option value="${esc(g.name)}" ${M.membersGroup === g.name ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
          </select>
          <select class="field" data-chg="membersRoleFilter">
            <option value="all">Усі ролі</option>
            <option value="student" ${M.membersRole === 'student' ? 'selected' : ''}>Студенти</option>
            <option value="starosta" ${M.membersRole === 'starosta' ? 'selected' : ''}>Старости</option>
            <option value="deputy" ${M.membersRole === 'deputy' ? 'selected' : ''}>Заступники старости</option>
          </select>
        </div>
      </div>

      <div class="card tbl-wrap" style="padding:0;overflow:hidden;">
        <table class="tbl" style="width:100%;margin:0;">
          <thead>
            <tr>
              <th>ПІБ</th>
              <th>Логін</th>
              <th>Група</th>
              <th>Роль</th>
              <th>Статус пароля</th>
              <th>Останній вхід</th>
              <th style="text-align:right;">Дії</th>
            </tr>
          </thead>
          <tbody>
            ${M.members.map((m) => `
              <tr>
                <td><b>${esc(m.fullName)}</b></td>
                <td><code>${esc(m.login || '—')}</code></td>
                <td>${esc(m.group)}</td>
                <td>${badge(m.roleTitle, m.role === 'starosta' ? 'accent' : m.role === 'deputy' ? 'sky' : 'gray')}</td>
                <td>${m.mustChangePassword ? badge('Тимчасовий', 'warn') : badge('Постійний', 'green')}</td>
                <td>${m.lastSeenAt ? esc(fmt.rel(m.lastSeenAt)) : '—'}</td>
                <td style="text-align:right;">
                  <div class="btn-row" style="justify-content:flex-end;">
                    <button class="btn small soft" data-act="navsResetPass" data-id="${esc(m.id)}" data-name="${esc(m.fullName)}">Скинути пароль</button>
                    <button class="btn small ghost" data-act="navsToggleBlock" data-id="${esc(m.id)}" data-blocked="${m.isBlocked ? '0' : '1'}">
                      ${m.isBlocked ? 'Розблокувати' : 'Блокувати'}
                    </button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    return h;
  }

  function openAddMemberModal() {
    D.openSheet({
      title: 'Додавання студента та генерація доступу',
      render: () => `
        <div class="card" style="max-width:440px;margin:0 auto;text-align:left;">
          <form id="addMemberForm" style="display:flex;flex-direction:column;gap:12px;">
            <div class="notice info small">
              Система автоматично згенерує унікальний логін у форматі <code>ivanenko.ip</code> та випадковий надійний тимчасовий пароль.
            </div>
            <label>
              <span class="label">Прізвище, Ім’я, По батькові</span>
              <input class="field" id="amName" required placeholder="Іваненко Іван Петрович" autofocus>
            </label>
            <label>
              <span class="label">Навчальна група</span>
              <select class="field" id="amGroup" required>
                ${(M.groupsFull || []).map((g) => `<option value="${esc(g.name)}">${esc(g.name)}</option>`).join('')}
              </select>
            </label>
            <label>
              <span class="label">Роль</span>
              <select class="field" id="amRole">
                <option value="student">Студент</option>
                <option value="starosta">Староста групи</option>
                <option value="deputy">Заступник старости</option>
              </select>
            </label>
            <div id="addMemberErr" class="err" style="min-height:16px;"></div>
            <button class="btn big" type="submit" id="submitAddMemberBtn" style="width:100%;">Створити обліковий запис</button>
          </form>
        </div>
      `,
    });
  }

  function showCredentialsModal(fullName, credentials) {
    const credText = `Логін: ${credentials.login}\nТимчасовий пароль: ${credentials.tempPassword}`;
    D.openSheet({
      title: 'Облікові дані створено',
      render: () => `
        <div class="card" style="max-width:440px;margin:0 auto;text-align:left;">
          <div class="notice green" style="margin-bottom:12px;">
            Обліковий запис для <b>${esc(fullName)}</b> успішно створено! Передайте ці дані студентові для першого входу.
          </div>
          <div class="cred-card">
            <div class="cred-row"><span>Логін:</span> <b>${esc(credentials.login)}</b></div>
            <div class="cred-row"><span>Тимчасовий пароль:</span> <b>${esc(credentials.tempPassword)}</b></div>
          </div>
          <div class="muted small" style="margin:12px 0;">
            Пароль показується лише зараз і збережений у базі в зашифрованому вигляді (Argon2id). При першому вході студент зобов’язаний змінити його на власний.
          </div>
          <button class="btn big" style="width:100%;" data-act="navsCopyCred" data-text="${esc(credText)}">
            📋 Копіювати облікові дані
          </button>
        </div>
      `,
    });
  }

  // ───────────────────────── Розклад та Автосинхронізація НАВС ─────────────────────────

  function viewNavsScheduleAdmin() {
    if (!M.schedSettings) return ui.skeleton(3, 96);

    const cfg = M.schedSettings.config || {};
    const lastRun = (M.schedRuns && M.schedRuns[0]) || null;

    let h = `
      <div class="card" style="margin-bottom:16px;">
        <div class="spread wrap" style="gap:12px;">
          <div>
            <div class="card-title" style="font-size:18px;">Автоматична інтеграція розкладу НАВС</div>
            <div class="card-sub">Офіційне джерело: <b>asu.navs.edu.ua</b></div>
          </div>
          <div class="btn-row">
            <button class="btn auto" data-act="navsScheduleSyncNow">${ic('refresh', 16)} Оновити з НАВС зараз</button>
            <button class="btn ghost auto" data-act="navsScheduleManualImport">${ic('file', 16)} Вставити розклад вручну</button>
          </div>
        </div>

        <div class="grid c3" style="margin-top:16px;gap:12px;">
          <div class="card deep tight">
            <span class="label">Стан синхронізації</span>
            <b>${lastRun && lastRun.status === 'success' ? badge('Синхронізовано', 'green') : badge('Захист Cloudflare / Останній розклад збережено', 'warn')}</b>
          </div>
          <div class="card deep tight">
            <span class="label">Остання успішна перевірка</span>
            <b>${cfg.lastSuccessAt ? esc(fmt.dateTime(cfg.lastSuccessAt)) : 'ще не було'}</b>
          </div>
          <div class="card deep tight">
            <span class="label">Інтервал автоматичної перевірки</span>
            <b>${esc(cfg.intervalMinutes || 60)} хвилин</b>
          </div>
        </div>

        <div style="margin-top:14px;display:flex;align-items:center;gap:10px;">
          <label style="display:flex;align-items:center;gap:8px;">
            <span>Змінити інтервал (хв):</span>
            <input class="field" type="number" id="schedIntervalInp" value="${esc(cfg.intervalMinutes || 60)}" min="5" max="1440" style="width:90px;">
          </label>
          <button class="btn small ghost" data-act="navsSaveInterval">Зберегти інтервал</button>
        </div>
      </div>

      <!-- Журнал останніх змін розкладу -->
      <div class="card tbl-wrap" style="padding:0;overflow:hidden;">
        <div style="padding:14px 16px;border-bottom:1px solid var(--line);font-weight:700;">
          Останні зміни пар (зафіксовані системою)
        </div>
        ${M.schedChanges && M.schedChanges.length ? `
          <table class="tbl" style="width:100%;margin:0;">
            <thead>
              <tr>
                <th>Група</th>
                <th>Тип зміни</th>
                <th>Опис зміни</th>
                <th>Дата фіксації</th>
              </tr>
            </thead>
            <tbody>
              ${M.schedChanges.map((c) => `
                <tr>
                  <td><b>${esc(c.group)}</b></td>
                  <td>${badge(c.title, c.type === 'rescheduled' ? 'warn' : c.type === 'room_change' ? 'sky' : 'green')}</td>
                  <td>${esc(c.description)}</td>
                  <td>${esc(fmt.rel(c.detectedAt))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<div style="padding:20px;text-align:center;" class="muted">Змін розкладу ще не зафіксовано. Усі пари актуальні.</div>'}
      </div>
    `;

    return h;
  }

  function openManualScheduleImportModal() {
    D.openSheet({
      title: 'Вставка розкладу НАВС вручну',
      render: () => `
        <div class="card" style="max-width:540px;margin:0 auto;text-align:left;">
          <form id="manualSchedForm" style="display:flex;flex-direction:column;gap:12px;">
            <div class="notice info small">
              Якщо офіційний сайт тимчасово показує захист Cloudflare, ви можете відкрити розклад у браузері на <b>asu.navs.edu.ua</b>, скопіювати HTML таблиці та вставити сюди. Система автоматично розпізнає пари, виявить зміни та сповістить студентів.
            </div>
            <label>
              <span class="label">Навчальна група</span>
              <select class="field" id="msGroup" required>
                ${(M.groupsFull || []).map((g) => `<option value="${esc(g.name)}">${esc(g.name)}</option>`).join('')}
              </select>
            </label>
            <label>
              <span class="label">Вміст таблиці розкладу (HTML або CSV)</span>
              <textarea class="field" id="msHtml" rows="8" placeholder="Вставте сюди HTML-код таблиці розкладу…" required></textarea>
            </label>
            <div id="manualSchedErr" class="err" style="min-height:16px;"></div>
            <button class="btn big" type="submit" id="submitManualSchedBtn" style="width:100%;">Обробити та зберегти розклад</button>
          </form>
        </div>
      `,
    });
  }

  // ───────────────────────── Обробники подій ─────────────────────────

  document.addEventListener('submit', async (e) => {
    // 1. Створення групи
    if (e.target.id === 'createGroupForm') {
      e.preventDefault();
      const name = $('#cgName').value.trim();
      const course = $('#cgCourse').value;
      const faculty = $('#cgFaculty').value;
      const btn = $('#submitCreateGroupBtn');
      const err = $('#createGroupErr');
      err.textContent = '';
      btn.disabled = true;
      try {
        await api('POST', '/api/admin/groups-full', { name, course, faculty });
        toast(`Групу «${name}» створено!`);
        D.closeSheet();
        loadGroupsFull();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    }

    // 2. Призначення старости
    if (e.target.id === 'assignStarostaForm') {
      e.preventDefault();
      const gid = e.target.dataset.gid;
      const starostaId = $('#asStarostaId').value || null;
      const deputyId = $('#asDeputyId').value || null;
      const err = $('#starostaErr');
      const btn = $('#saveStarostaBtn');
      err.textContent = '';
      btn.disabled = true;
      try {
        await api('POST', `/api/admin/groups-full/${encodeURIComponent(gid)}/starosta`, { starostaId, deputyId });
        toast('Призначення успішно збережено!');
        D.closeSheet();
        loadGroupsFull();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    }

    // 3. Збереження параметрів розкладу
    if (e.target.id === 'schedConfigForm') {
      e.preventDefault();
      const gid = e.target.dataset.gid;
      const faculty = $('#scFaculty').value;
      const course = $('#scCourse').value;
      const externalGroup = $('#scExternal').value.trim();
      const autoSync = $('#scAuto').checked;
      const err = $('#schedConfigErr');
      const btn = $('#saveSchedConfigBtn');
      err.textContent = '';
      btn.disabled = true;
      try {
        await api('POST', `/api/admin/groups-full/${encodeURIComponent(gid)}/schedule-config`, {
          faculty, course, externalGroup, autoSync,
        });
        toast('Налаштування розкладу збережено!');
        D.closeSheet();
        loadGroupsFull();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    }

    // 4. Додавання учасника
    if (e.target.id === 'addMemberForm') {
      e.preventDefault();
      const fullName = $('#amName').value.trim();
      const group = $('#amGroup').value;
      const role = $('#amRole').value;
      const err = $('#addMemberErr');
      const btn = $('#submitAddMemberBtn');
      err.textContent = '';
      btn.disabled = true;
      try {
        const res = await api('POST', '/api/admin/members', { fullName, group, role });
        D.closeSheet();
        loadMembers();
        showCredentialsModal(fullName, res.credentials);
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    }

    // 5. Ручний імпорт розкладу
    if (e.target.id === 'manualSchedForm') {
      e.preventDefault();
      const group = $('#msGroup').value;
      const html = $('#msHtml').value.trim();
      const err = $('#manualSchedErr');
      const btn = $('#submitManualSchedBtn');
      err.textContent = '';
      btn.disabled = true;
      try {
        const res = await api('POST', '/api/admin/schedule/import', { group, html });
        toast('Розклад успішно розібрано та оновлено!');
        D.closeSheet();
        loadScheduleAdmin();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    }
  });

  // Кліки для адміністративних дій НАВС
  document.addEventListener('click', async (e) => {
    // Копіювання облікових даних
    const copyBtn = e.target.closest('[data-act="navsCopyCred"]');
    if (copyBtn) {
      const text = copyBtn.dataset.text;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '✅ Скопійовано!';
        toast('Облікові дані скопійовано в буфер обміну.');
      } catch (err) {
        prompt('Скопіюйте дані вручну:', text);
      }
    }

    // Скидання пароля студента
    const resetBtn = e.target.closest('[data-act="navsResetPass"]');
    if (resetBtn) {
      const id = resetBtn.dataset.id;
      const name = resetBtn.dataset.name;
      if (!confirm(`Згенерувати новий тимчасовий пароль для студента «${name}»?`)) return;
      try {
        const r = await api('POST', `/api/admin/members/${encodeURIComponent(id)}/reset-password`);
        showCredentialsModal(name, r.credentials);
        loadMembers();
      } catch (ex) {
        toast('Помилка скидання пароля: ' + ex.message);
      }
    }

    // Блокування / розблокування
    const blockBtn = e.target.closest('[data-act="navsToggleBlock"]');
    if (blockBtn) {
      const id = blockBtn.dataset.id;
      const blocked = blockBtn.dataset.blocked === '1';
      try {
        await api('POST', `/api/admin/members/${encodeURIComponent(id)}/block`, { blocked });
        toast(blocked ? 'Користувача заблоковано.' : 'Користувача розблоковано.');
        loadMembers();
      } catch (ex) {
        toast(ex.message);
      }
    }

    // Експорт CSV
    const expBtn = e.target.closest('[data-act="navsExportMembers"]');
    if (expBtn) {
      try {
        const r = await api('GET', '/api/admin/members/export');
        const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = r.filename;
        a.click();
        URL.revokeObjectURL(url);
        toast('Файл експорту успішно завантажено.');
      } catch (ex) {
        toast('Помилка експорту: ' + ex.message);
      }
    }

    // Ручний запуск синхронізації НАВС
    const syncNowBtn = e.target.closest('[data-act="navsScheduleSyncNow"]');
    if (syncNowBtn) {
      syncNowBtn.disabled = true;
      syncNowBtn.innerHTML = '<span class="spin"></span> Оновлюю…';
      try {
        const res = await api('POST', '/api/admin/schedule/sync');
        toast('Синхронізація розкладу завершена!');
        loadScheduleAdmin();
      } catch (ex) {
        toast('Помилка синхронізації: ' + ex.message);
      } finally {
        syncNowBtn.disabled = false;
        syncNowBtn.innerHTML = `${ic('refresh', 16)} Оновити з НАВС зараз`;
      }
    }

    // Збереження інтервалу
    const saveIntBtn = e.target.closest('[data-act="navsSaveInterval"]');
    if (saveIntBtn) {
      const val = parseInt($('#schedIntervalInp').value, 10) || 60;
      try {
        await api('PUT', '/api/admin/schedule/settings', { intervalMinutes: val, autoSync: true });
        toast('Інтервал успішно збережено!');
        loadScheduleAdmin();
      } catch (ex) {
        toast(ex.message);
      }
    }

    // Відкриття модальних вікон
    if (e.target.closest('[data-act="navsGroupCreate"]')) openCreateGroupModal();
    if (e.target.closest('[data-act="navsMemberAdd"]')) openAddMemberModal();
    if (e.target.closest('[data-act="navsScheduleManualImport"]')) openManualScheduleImportModal();

    const dtBtn = e.target.closest('[data-act="navsGroupDetail"]');
    if (dtBtn) openGroupDetailModal(dtBtn.dataset.id);

    const scBtn = e.target.closest('[data-act="navsGroupSched"]');
    if (scBtn) openGroupSchedConfigModal(scBtn.dataset.id);

    const stBtn = e.target.closest('[data-act="navsStarostaAssign"]');
    if (stBtn) openStarostaAssignModal(stBtn.dataset.id);
  });

  // ───────────── Реєстрація сторінок НАВС ─────────────
  // Pages are defined in app.js PAGES with keys: admin/groups-full, admin/members, admin/schedule-admin
  // The register() call in admin.js adds them to the page registry, so we just register our
  // render functions as hooks for those page keys.
  function renderPage(key) {
    const fn = RENDERERS[key];
    if (fn) return fn();
    return '';
  }
  window.DiaryNavs = { loadGroupsFull, loadMembers, loadScheduleAdmin, renderPage };

  D.register({
    pages: {
      'admin/groups-full': { render: viewNavsGroups, enter: () => loadGroupsFull() },
      'admin/members': { render: viewNavsMembers, enter: () => { loadGroupsFull(); loadMembers(); } },
      'admin/schedule-admin': { render: viewNavsScheduleAdmin, enter: () => loadScheduleAdmin() },
    },
    actions: {
      navsGroupCreate: openCreateGroupModal,
      navsMemberAdd: openAddMemberModal,
      navsScheduleManualImport: openManualScheduleImportModal,
    },
    inputs: {
      membersSearch(el) {
        M.membersQ = el.value.trim();
        loadMembers();
      },
    },
    changes: {
      membersGroupFilter(el) {
        M.membersGroup = el.value;
        loadMembers();
      },
      membersRoleFilter(el) {
        M.membersRole = el.value;
        loadMembers();
      },
    },
  });
})();
